/**
 * researchSignals.open(), pure: the one Research Twin job writer, driven against an in-memory stand-in
 * for exactly the SQL it issues. Run with: npm run test:research-signals-open
 *
 * Pins the behaviour every trigger (T4, T5, T6, T8, MONITORING) already had, and the two changes of
 * 27 Oct 2026 (SE8L / YEAO): a job opened before its signal row was told is adopted in any status,
 * never opened twice; and a status outside the job vocabulary is never reopened. The stand-in honours
 * the advisory lock by running transactions one at a time, which is what Postgres does with it; it
 * proves the code's decisions, not Postgres. research-signals.test.cjs is the database half.
 */
const assert = require('node:assert/strict');
const path = require('node:path');

const DIST = process.env.SERVER_DIST || path.join(__dirname, '../../server-dist');
const pg = require(path.join(DIST, 'server/src/pg.js'));
const engineWrite = require(path.join(DIST, 'server/src/engineWrite.js'));
const engineEvents = require(path.join(DIST, 'server/src/engineEvents.js'));
const rs = require(path.join(DIST, 'server/src/researchSignals.js'));

let passed = 0;
const ok = (name) => { passed++; console.log(`  ok  ${name}`); };

/* ---------------------------------------------------------------- the stand-in */
function world() {
  const w = { signals: new Map(), jobs: [], seq: 0, posts: 0, failPost: false, failBookkeeping: false, events: [] };
  const sig = (id) => [...w.signals.values()].find((r) => r.id === id);
  const startOfDay = () => { const d = new Date(); d.setUTCHours(0, 0, 0, 0); return d.getTime(); };
  const run = async (sql, p = []) => {
    const q = sql.replace(/\s+/g, ' ').trim();
    const none = { rows: [], rowCount: 0 };
    if (q.startsWith('SELECT pg_advisory_xact_lock')) return none;
    if (q.startsWith('SELECT id::text, signal_id, state, job_id, refs, rearm_days, opened_at::text, attempts')) {
      const r = w.signals.get(p[0]);
      return r ? { rows: [{ ...r, refs: [...r.refs], previous_jobs: [...r.previous_jobs] }], rowCount: 1 } : none;
    }
    if (q.startsWith("SELECT natural_id AS job_id, fields->>'Status' AS status, fields->>'Opened At' AS opened_at FROM engine_rt_jobs")) {
      const prev = JSON.parse(p[1]);
      const j = [...w.jobs].reverse().find((x) => x.fields['Signal Key'] === p[0] && x.natural_id && !prev.includes(x.natural_id));
      return j ? { rows: [{ job_id: j.natural_id, status: j.fields.Status ?? null, opened_at: j.fields['Opened At'] ?? null }], rowCount: 1 } : none;
    }
    if (q.startsWith("SELECT fields->>'Status' AS status FROM engine_rt_jobs WHERE natural_id")) {
      const j = [...w.jobs].reverse().find((x) => x.natural_id === p[0]);
      return j ? { rows: [{ status: j.fields.Status ?? null }], rowCount: 1 } : none;
    }
    if (q.startsWith("SELECT natural_id AS job_id FROM engine_rt_jobs WHERE fields->>'Signal Key' = $1 AND fields->>'Status' = ANY($2)")) {
      const j = [...w.jobs].reverse().find((x) => x.fields['Signal Key'] === p[0] && p[1].includes(x.fields.Status) && x.natural_id);
      return j ? { rows: [{ job_id: j.natural_id }], rowCount: 1 } : none;
    }
    if (q.startsWith("SELECT id::text, fields->>'Context' AS context FROM engine_rt_jobs")) {
      const j = w.jobs.find((x) => x.natural_id === p[0]);
      return j ? { rows: [{ id: String(j.id), context: j.fields.Context ?? '' }], rowCount: 1 } : none;
    }
    if (q.startsWith('SELECT signal_id, state, job_id, (opened_at > now()')) {
      const r = w.signals.get(p[0]);
      return r ? { rows: [{ signal_id: r.signal_id, state: r.state, job_id: r.job_id, fresh: r.opened_at !== null && Date.now() - Date.parse(r.opened_at) < 120_000 }], rowCount: 1 } : none;
    }
    if (q.startsWith('SELECT count(*)::int AS opened')) {
      const today = [...w.signals.values()].filter((r) => r.signal_key !== p[0] && r.opened_at && Date.parse(r.opened_at) >= startOfDay());
      return { rows: [{ opened: today.length, backlog: today.filter((r) => r.priority === 2).length }], rowCount: 1 };
    }
    if (q.startsWith('INSERT INTO engine_research_signals')) {
      const [signal_id, key, trigger, source, priority, , , question, context, refs, rearm, state, reason, , , ref, previous] = p;
      const now = new Date().toISOString();
      let r = w.signals.get(key);
      if (!r) {
        r = { id: String(++w.seq), signal_id, signal_key: key, trigger_code: trigger, source, priority, question, context, refs: JSON.parse(refs), rearm_days: rearm, state, reason, job_id: null, previous_jobs: [], attempts: 0, opened_at: state === 'opening' ? now : null };
        w.signals.set(key, r);
      } else {
        r.state = state; r.reason = reason; r.question = question; r.context = context;
        if (!r.refs.includes(ref)) r.refs.push(ref);
        if (previous !== null) { r.previous_jobs.push(previous); r.job_id = null; }
        r.opened_at = state === 'opening' ? now : previous === null ? r.opened_at : null;
      }
      return { rows: [{ id: r.id, signal_id: r.signal_id }], rowCount: 1 };
    }
    if (q.startsWith("UPDATE engine_research_signals SET state = 'job_opened', job_id = $2, reason = NULL, attempts = attempts + 1")) {
      if (w.failBookkeeping) throw new Error('connection lost after the job was written');
      const r = sig(p[0]); r.state = 'job_opened'; r.job_id = p[1]; r.reason = null; r.attempts++;
      return { rows: [], rowCount: 1 };
    }
    if (q.startsWith("UPDATE engine_research_signals SET state = 'job_opened', job_id = $2, reason = NULL, opened_at = coalesce(opened_at, $3::timestamptz) WHERE id = $1 AND job_id IS NULL")) {
      const r = sig(p[0]); if (r.job_id) return none;
      r.state = 'job_opened'; r.job_id = p[1]; r.reason = null; r.opened_at = r.opened_at ?? p[2];
      return { rows: [], rowCount: 1 };
    }
    if (q.startsWith("UPDATE engine_research_signals SET state = 'job_opened', job_id = $2, reason = NULL, last_seen_at = now(), opened_at = coalesce(opened_at, now())")) {
      const r = sig(p[0]); r.state = 'job_opened'; r.job_id = p[1]; r.opened_at = r.opened_at ?? new Date().toISOString(); if (!r.refs.includes(p[2])) r.refs.push(p[2]);
      return { rows: [], rowCount: 1 };
    }
    if (q.startsWith('UPDATE engine_research_signals SET refs = refs || $2::jsonb, occurrences')) {
      const r = sig(p[0]); r.refs.push(...JSON.parse(p[1])); return { rows: [], rowCount: 1 };
    }
    if (q.startsWith('UPDATE engine_research_signals SET last_seen_at = now(), refs = refs || to_jsonb($2::text)')) {
      const r = sig(p[0]); r.refs.push(p[1]); return { rows: [], rowCount: 1 };
    }
    if (q.startsWith("UPDATE engine_research_signals SET state = 'failed'")) {
      const r = sig(p[0]); r.state = 'failed'; r.reason = p[1]; r.opened_at = null; r.attempts++; return { rows: [], rowCount: 1 };
    }
    throw new Error(`the stand-in does not know this statement: ${q.slice(0, 140)}`);
  };
  let chain = Promise.resolve();
  w.query = run;
  // The advisory lock: one transaction at a time.
  w.withTransaction = (fn) => {
    const next = chain.then(() => fn({ query: run }));
    chain = next.catch(() => undefined);
    return next;
  };
  w.post = async (_kind, rec) => {
    await new Promise((r) => setImmediate(r));
    if (w.failPost) throw new Error('rt-jobs refused the write');
    w.posts++;
    w.jobs.push({ id: w.jobs.length + 1, natural_id: rec.fields['Job ID'], fields: { ...rec.fields } });
    return { natural_id: rec.fields['Job ID'] };
  };
  w.setStatus = (jobId, status) => { w.jobs.find((j) => j.natural_id === jobId).fields.Status = status; };
  w.age = (key, days) => { const r = w.signals.get(key); r.opened_at = new Date(Date.now() - days * 86_400_000).toISOString(); };
  return w;
}

const real = { query: pg.query, withTransaction: pg.withTransaction, postRecord: engineWrite.postRecord, patchRecord: engineWrite.patchRecord, record: engineEvents.record, fetch: global.fetch, key: process.env.OPENROUTER_API_KEY, error: console.error };
function install(w, credit = 100) {
  pg.query = w.query;
  pg.withTransaction = w.withTransaction;
  engineWrite.postRecord = w.post;
  engineWrite.patchRecord = async (_k, id, fields) => { const j = w.jobs.find((x) => String(x.id) === id); Object.assign(j.fields, fields); return {}; };
  engineEvents.record = async (e) => { w.events.push(e.event_type); return { recorded: true, id: w.events.length }; };
  process.env.OPENROUTER_API_KEY = 'test-only';
  global.fetch = async () => ({ status: 200, text: async () => JSON.stringify({ data: { total_credits: credit, total_usage: 0 } }) });
  rs.forgetCredit();
  console.error = () => undefined;
}
function uninstall() {
  pg.query = real.query; pg.withTransaction = real.withTransaction;
  engineWrite.postRecord = real.postRecord; engineWrite.patchRecord = real.patchRecord;
  engineEvents.record = real.record; global.fetch = real.fetch; console.error = real.error;
  if (real.key === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = real.key;
  rs.forgetCredit();
}

const signal = (trigger, extra = {}) => ({ trigger, key: `${trigger.toLowerCase()}:case`, source: `test ${trigger}`, ref: 'ref-1', question: `Question for ${trigger}?`, context: 'context', rearm_days: 7, ...extra });

(async () => {
  try {
    /* ---------------------------------------- what every trigger already did */
    for (const trigger of ['T4', 'T5', 'T6', 'T8', 'MONITORING']) {
      const w = world();
      install(w);
      const s = signal(trigger);
      const first = await rs.open(s);
      assert.equal(first.state, 'job_opened');
      assert.equal(w.posts, 1);
      assert.equal(w.jobs[0].fields['Signal Key'], s.key);
      assert.equal(w.jobs[0].fields['Opened By Trigger'], trigger);
      assert.deepEqual(await rs.open(s), { state: 'job_opened', signal_id: first.signal_id, job_id: first.job_id, reason: null });
      assert.equal((await rs.open({ ...s, ref: 'ref-2' })).state, 'added_to_job');
      assert.equal(w.posts, 1, 'an open job is added to, never doubled');
      w.setStatus(first.job_id, 'Capped (needs human)');
      assert.equal((await rs.open({ ...s, ref: 'ref-3' })).state, 'not_reopened');
      w.setStatus(first.job_id, 'Resolved');
      const early = await rs.open({ ...s, ref: 'ref-4' });
      assert.deepEqual([early.state, early.wait], ['not_reopened', true]);
      w.age(s.key, 8);
      const again = await rs.open({ ...s, ref: 'ref-5' });
      assert.equal(again.state, 'job_opened');
      assert.notEqual(again.job_id, first.job_id);
      assert.equal(w.posts, 2);
      assert.deepEqual(w.signals.get(s.key).previous_jobs, [first.job_id]);
      w.jobs.splice(w.jobs.findIndex((j) => j.natural_id === again.job_id), 1);
      assert.match((await rs.open({ ...s, ref: 'ref-6' })).reason, /removed by a person/);
      uninstall();

      const once = world();
      install(once);
      const n = { ...signal(trigger), rearm_days: null };
      const j = await rs.open(n);
      once.setStatus(j.job_id, 'Resolved');
      once.age(n.key, 400);
      assert.match((await rs.open({ ...n, ref: 'ref-2' })).reason, /already researched once/);
      uninstall();
      ok(`${trigger}: opens once, repeats are no-ops, a new ref is added to the open job, capped and removed are never reopened, rearm waits its days, rearm null never reopens (unchanged)`);
    }
    {
      const w = world();
      install(w, 9);
      const held = await rs.open(signal('T4'));
      assert.equal(held.state, 'held_credit');
      assert.equal(w.posts, 0);
      uninstall();
      const b = world();
      install(b);
      for (let i = 0; i < 5; i++) assert.equal((await rs.open(signal('T5', { key: `t5:${i}` }))).state, 'job_opened');
      assert.equal((await rs.open(signal('T5', { key: 't5:6' }))).state, 'held_budget');
      assert.equal(b.posts, 5);
      uninstall();
      ok('the credit floor and the daily budget still hold a signal without opening a job (unchanged)');
    }

    /* ------------------------------------------- 27 Oct: a lost bookkeeping write */
    for (const status of ['Resolved', 'Capped (needs human)', 'Pending']) {
      const w = world();
      install(w);
      const s = signal('T4', { rearm_days: 7 });
      w.failBookkeeping = true;
      const lost = await rs.open(s);
      assert.equal(lost.state, 'job_opened', 'the job landed; open() logs the lost write and says so');
      assert.equal(w.signals.get(s.key).job_id, null, 'and the row was not told');
      assert.equal(w.posts, 1);
      w.failBookkeeping = false;
      const jobId = w.jobs[0].natural_id;
      w.setStatus(jobId, status);
      w.age(s.key, 1);
      const next = await rs.open(s);
      assert.equal(w.posts, 1, `a ${status} job carrying the key is this signal's job: no second one`);
      assert.equal(w.signals.get(s.key).job_id, jobId);
      assert.ok(['job_opened', 'not_reopened'].includes(next.state));
      uninstall();
    }
    ok('a job written before its signal row was told is adopted whatever its status by then (Pending, Resolved, Capped): no second job, and the existing rules then apply to it');
    {
      // Before 27 Oct: a Resolved job the row was never told about was invisible, so the next pass opened a second.
      const w = world();
      install(w);
      const s = signal('T5', { rearm_days: 7 });
      w.failBookkeeping = true;
      await rs.open(s);
      w.failBookkeeping = false;
      w.setStatus(w.jobs[0].natural_id, 'Resolved');
      w.age(s.key, 1);
      const r = await rs.open({ ...s, ref: 'ref-2' });
      assert.deepEqual([r.state, r.wait], ['not_reopened', true]);
      assert.equal(w.posts, 1);
      uninstall();
      ok('the regression itself: a resolved job whose bookkeeping was lost waits out its rearm days instead of being opened again');
    }
    {
      // rearm 0, as the doctrine detector uses: after adoption the existing re-arm rule applies, and the
      // job adopted is always the newest one the row has not already moved past.
      const w = world();
      install(w);
      const s = signal('T4', { rearm_days: 0 });
      const ids = () => w.jobs.map((j) => j.natural_id);
      w.failBookkeeping = true;
      await rs.open(s);
      w.failBookkeeping = false;
      w.setStatus(ids()[0], 'Resolved');
      w.age(s.key, 1);
      const second = await rs.open({ ...s, ref: 'episode-2' });
      assert.equal(second.state, 'job_opened');
      assert.deepEqual(w.signals.get(s.key).previous_jobs, [ids()[0]], 'job 1 was adopted, then re-armed past');
      w.setStatus(second.job_id, 'Resolved');
      w.failBookkeeping = true;
      await rs.open({ ...s, ref: 'episode-3' });
      w.failBookkeeping = false;
      assert.equal(w.signals.get(s.key).job_id, null);
      w.setStatus(ids()[2], 'Resolved');
      w.age(s.key, 1);
      await rs.open({ ...s, ref: 'episode-4' });
      assert.deepEqual(w.signals.get(s.key).previous_jobs, [ids()[0], ids()[1], ids()[2]], 'job 3 was adopted, never job 1 or 2 again');
      uninstall();
      ok('adoption never picks a job the row has already moved past (previous_jobs), so a re-armed signal adopts the right job');
    }
    {
      const w = world();
      install(w);
      const s = signal('T6');
      w.failPost = true;
      const failed = await rs.open(s);
      assert.equal(failed.state, 'failed');
      assert.equal(w.posts, 0);
      w.failPost = false;
      const retried = await rs.open(s);
      assert.equal(retried.state, 'job_opened');
      assert.equal(w.posts, 1);
      uninstall();
      ok('a job write that fails gives the slot back and the next pass opens exactly one (unchanged)');
    }

    /* ---------------------------------------------- 27 Oct: unknown statuses */
    for (const status of ['Parked', '', 'resolved']) {
      const w = world();
      install(w);
      const s = signal('T8', { rearm_days: 0 });
      const first = await rs.open(s);
      w.setStatus(first.job_id, status);
      w.age(s.key, 30);
      const r = await rs.open({ ...s, ref: 'ref-2' });
      assert.equal(r.state, 'not_reopened', `status "${status}"`);
      assert.match(r.reason, /not one this guard knows/);
      assert.equal(w.posts, 1);
      uninstall();
    }
    ok('a status outside Pending / In Progress / Resolved / Capped (needs human), an empty one included, is never reopened, even with rearm 0 and 30 days gone');

    /* ------------------------------------------------------------ concurrency */
    {
      const w = world();
      install(w);
      const s = signal('T4');
      const results = await Promise.all([rs.open(s), rs.open(s), rs.open(s)]);
      assert.equal(w.posts, 1, 'three passes at once open one job');
      assert.equal(results.filter((r) => r.state === 'job_opened').length >= 1, true);
      assert.ok(results.every((r) => r.state === 'job_opened' || /another pass is opening/.test(r.reason ?? '')));
      uninstall();
      ok('three passes for one signal at once open exactly one job; the others are told it is being opened (lock simulated, not Postgres)');
    }
  } finally {
    uninstall();
  }
  console.log(`\n${passed} research-signals open() checks passed.`);
})().catch((e) => { uninstall(); console.error(e); process.exit(1); });
