/**
 * Research Twin's six write tools (2026-09-24), pinned end to end: the real
 * server process and MCP transport, a local database, and local stand-ins for
 * Slack (the Research Twin bot) and BHARAG, so every outcome can be driven.
 *
 *   queue_followup_research — items as a JSON string; one Pending job per usable
 *     item, JOB-<ms>-<4>; none usable is ok:false and writes nothing.
 *   write_research_finding — refused with no sources; a low answer on the third
 *     attempt caps the job; a clean answer Resolves it, appends Answer History
 *     and Sources, and reaches back onto the card (research_gleanings appended,
 *     missing_research_count down one); queue_row_id by row id and by Job ID;
 *     no open job is ok:false.
 *   write_commercial_card_fields — ISO-stamped appends, the decrement only on
 *     missing_research_resolved, "No card found" writes nothing.
 *   compute_lane_state — the three transitions and none; no card writes nothing.
 *   update_watched_client_question — the merge, the BHARAG doc with the RT key,
 *     and a BHARAG failure that leaves the row written.
 *   create_client_report_doc — the Slack upload as the RT bot into
 *     C0B9LKU7DQV with the initial_comment; an unknown client names the lanes.
 *   delete_record — rt-asks is deletable, with the confirm.
 *
 * Run with:  npm run test:research-twin   (needs a LOCAL DATABASE_URL)
 */
const assert = require('node:assert/strict');
const http = require('node:http');
const { spawn } = require('node:child_process');
const path = require('node:path');

if (!/@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL || '')) {
  console.error('test:research-twin writes rows, so it only runs against a local DATABASE_URL (localhost or 127.0.0.1).');
  process.exit(1);
}

const TOKEN = 'one-url-for-test';
const INBOUND = 'inbound-for-test';
const PORT = 5079;
const S = String(Date.now()).slice(-6);
const CARD = `CARD-RTTEST-${S}`;
const CARD2 = `CARD-RTTEST2-${S}`;
const TABLE = `tblRtTest${S}xyzAB`.slice(0, 17); // tbl + 14
const LANE_NAME = `Zeta Testlane ${S}`;
const QREC = `recRtQ${S}abcdefgh`.slice(0, 17);

/* ------------------------------------------------------------ stand-ins */

const seen = { slack: [], bharag: [] };
let bharagFails = false;
const slack = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks);
    const u = new URL(req.url, 'http://x');
    const answer = (b) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(b));
    };
    seen.slack.push({ path: u.pathname, auth: req.headers.authorization || null, raw });
    if (u.pathname === '/api/files.getUploadURLExternal') return answer({ ok: true, upload_url: 'https://files.slack.com/upload/v1/RT1', file_id: 'F0RTREPORT' });
    if (u.pathname === '/upload/v1/RT1') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end('OK');
    }
    if (u.pathname === '/api/files.completeUploadExternal') return answer({ ok: true, files: [{ id: 'F0RTREPORT', title: 't' }] });
    if (u.pathname === '/api/files.info') return answer({ ok: true, file: { permalink: 'https://bha.slack.com/files/U0RT/F0RTREPORT/report.md' } });
    answer({ ok: false, error: 'unknown_method' });
  });
});
const bharagSrv = http.createServer((req, res) => {
  let b = '';
  req.on('data', (c) => (b += c));
  req.on('end', () => {
    seen.bharag.push({ path: req.url, key: req.headers['x-api-key'], body: b ? JSON.parse(b) : null });
    if (bharagFails) {
      res.writeHead(500, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ detail: 'boom' }));
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ document_id: 'doc-1' }));
  });
});

/* ------------------------------------------------------------ the client */

let rpcId = 0;
function request(method, pathname, payload, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: pathname, method, headers: { 'content-type': 'application/json', accept: 'application/json', ...headers } }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve({ status: res.statusCode, body: b ? JSON.parse(b) : null }));
    });
    req.on('error', reject);
    req.end(payload === undefined ? undefined : JSON.stringify(payload));
  });
}
async function call(name, args) {
  const r = await request('POST', `/mcp/${TOKEN}`, { jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } });
  if (r.body.error) return { rpcError: r.body.error };
  return JSON.parse(r.body.result.content[0].text);
}
const seed = (kind, body) => request('POST', `/api/engine/${kind}`, body, { 'x-dashboard-key': INBOUND });
const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${s.address().port}`)));

(async () => {
  const [slackUrl, bharagUrl] = await Promise.all([listen(slack), listen(bharagSrv)]);
  const env = {
    ...process.env,
    PORT: String(PORT),
    MCP_SECRET: TOKEN,
    MCP_WRITE_TOKEN: TOKEN,
    DASHBOARD_INBOUND_KEY: INBOUND,
    RECOVERY_ENABLED: 'false',
    SLACK_RESEARCH_TWIN_BOT_TOKEN: 'xoxb-rt-test',
    SLACK_BAYS_BOT_TOKEN: 'xoxb-bays-test',
    SLACK_API_URL: `${slackUrl}/api`,
    SLACK_FILES_ORIGIN: slackUrl,
    BHARAG_API_URL: bharagUrl,
    BHARAG_RESEARCH_TWIN_KEY: 'rt-key',
  };
  const server = spawn(process.execPath, ['--no-warnings=ExperimentalWarning', path.join(__dirname, '../../server-dist/server/src/index.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  server.stdout.on('data', (c) => (log += c));
  server.stderr.on('data', (c) => (log += c));
  for (let i = 0; i < 80; i++) {
    await new Promise((r) => setTimeout(r, 250));
    if (/listening|http:\/\//i.test(log) && (await request('POST', '/mcp/nope', {}).catch(() => null))) break;
  }
  const { query, closePool } = require('../../server-dist/server/src/pg.js');
  const rt = require('../../server-dist/server/src/mcp/researchTwinTools.js');
  const passed = [];
  const step = (name) => passed.push(name);
  const jobRow = async (jobId) => (await query(`SELECT id, fields FROM engine_rt_jobs WHERE natural_id = $1`, [jobId])).rows[0];
  const cardRow = async (cardId) => (await query(`SELECT id, fields FROM engine_commercial_cards WHERE natural_id = $1`, [cardId])).rows[0];

  try {
    const tools = (await request('POST', `/mcp/${TOKEN}`, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).body.result.tools;
    const names = tools.map((t) => t.name);
    for (const t of ['write_research_finding', 'write_commercial_card_fields', 'compute_lane_state', 'queue_followup_research', 'update_watched_client_question', 'create_client_report_doc']) assert.ok(names.includes(t), `lists ${t}`);
    assert.ok(tools.find((t) => t.name === 'delete_record').inputSchema.properties.kind.enum.includes('rt-asks'), 'delete_record takes rt-asks');
    assert.ok(!tools.find((t) => t.name === 'create_record').inputSchema.properties.kind.enum.includes('rt-asks'), 'but create_record does not');
    step('six tools listed; delete_record takes rt-asks, create_record does not');

    /* ---- seed ---- */
    for (const [card, n] of [[CARD, 2], [CARD2, 0]]) {
      const r = await seed('commercial', { fields: { card_id: card, opportunity_title: `RT test ${card}`, research_gleanings: 'earlier entry', missing_research_count: n, lane_state: 'research_first', pilot_state: 'research_only' } });
      assert.ok(r.status < 300, JSON.stringify(r.body));
    }

    /* ---- queue_followup_research ---- */
    const items = JSON.stringify([
      { research_required: 'missing_proof', hypothesis_to_validate: 'Buyers pay monthly', context_snippet: 'why A' },
      { question: 'Second question', context: 'why B' },
      { research_required: 'nothing usable' },
    ]);
    const dryQ = await call('queue_followup_research', { card_id: CARD, lane_id: 'LANE-RT-TEST', items, dry_run: true });
    assert.equal(dryQ.dry_run, true);
    assert.equal(dryQ.would_create.length, 2);
    const q = await call('queue_followup_research', { card_id: CARD, lane_id: 'LANE-RT-TEST', items });
    assert.equal(q.ok, true, JSON.stringify(q));
    assert.equal(q.rows_created, 2);
    for (const id of q.job_ids) assert.match(id, /^JOB-\d{13}-[A-Z0-9]{1,4}$/);
    const j1 = await jobRow(q.job_ids[0]);
    assert.deepEqual(
      { Q: j1.fields.Question, C: j1.fields.Context, card: j1.fields['Card ID'], lane: j1.fields.Lane, st: j1.fields.Status, a: j1.fields.Attempts, by: j1.fields['Opened By'] },
      { Q: 'Buyers pay monthly', C: 'why A', card: CARD, lane: 'LANE-RT-TEST', st: 'Pending', a: 0, by: 'Research Twin' },
    );
    const none = await call('queue_followup_research', { card_id: CARD, items: '[{"x":1}]' });
    assert.equal(none.ok, false);
    assert.equal(none.reason, 'no_usable_items');
    step('queue_followup_research: JSON-string items, one Pending job each, none usable is ok:false');

    /* ---- write_research_finding ---- */
    const noSrc = await call('write_research_finding', { queue_row_id: q.job_ids[0], finding: 'F', sources: [], confidence: 'high' });
    assert.equal(noSrc.ok, false);
    assert.equal(noSrc.reason, 'no_sources');
    assert.equal((await jobRow(q.job_ids[0])).fields.Attempts, 0, 'a refusal writes nothing');

    // Newest open job for the card is the second one queued; drive the first by Job ID.
    const low1 = await call('write_research_finding', { queue_row_id: q.job_ids[0], finding: 'thin', sources: '["[S1] a - https://a"]', confidence: 'low', gap_classification: 'missing_sources' });
    assert.equal(low1.status, 'In Progress');
    assert.equal(low1.attempts, 1);
    assert.equal(low1.card_updated, false);
    const jid = String((await jobRow(q.job_ids[0])).id);
    await call('write_research_finding', { queue_row_id: jid, finding: 'thin again', sources: ['b'], confidence: 'low' });
    const low3 = await call('write_research_finding', { queue_row_id: q.job_ids[0], finding: 'still thin', sources: ['c'], confidence: 'low' });
    assert.equal(low3.status, 'Capped (needs human)');
    assert.equal(low3.requires_human, true);
    const capped = (await jobRow(q.job_ids[0])).fields;
    assert.equal(capped.Attempts, 3);
    assert.equal(capped['Gap Type'], 'Other');
    assert.equal(capped.Sources, '[S1] a - https://a; b; c');
    assert.equal(capped['Answer History'].split('\n\n').length, 3);
    assert.ok(capped['Resolved At']);
    step('write_research_finding: no sources refused; low attempts go In Progress then Capped (needs human) on the 3rd');

    const beforeCard = (await cardRow(CARD)).fields;
    const good = await call('write_research_finding', { card_id: CARD, finding: 'Clean answer [S1]', sources: ['[S1] src - https://x.y'], confidence: 'high', verdict: 'Ready' });
    assert.equal(good.ok, true, JSON.stringify(good));
    assert.equal(good.status, 'Resolved');
    assert.equal(good.job_id, q.job_ids[1], 'the newest open job for the card');
    assert.equal(good.card_updated, true);
    const afterCard = (await cardRow(CARD)).fields;
    assert.equal(afterCard.missing_research_count, beforeCard.missing_research_count - 1);
    assert.match(afterCard.research_gleanings, /^earlier entry\n\n\[\d{4}-\d{2}-\d{2}T[^\]]+Z\] \(from Research Jobs, resolved after 1 attempt\(s\)\) Clean answer \[S1\]\nSources: \[S1\] src - https:\/\/x\.y$/);
    assert.equal((await jobRow(q.job_ids[1])).fields.Verdict, 'Ready');
    const noJob = await call('write_research_finding', { card_id: CARD, finding: 'x', sources: ['s'], confidence: 'high' });
    assert.equal(noJob.ok, false);
    assert.equal(noJob.reason, 'not_found', 'no OPEN job left for the card');
    step('write_research_finding: a clean answer Resolves the newest open job and reaches back onto the card; no open job is ok:false');

    /* ---- write_commercial_card_fields ---- */
    const miss = await call('write_commercial_card_fields', { card_id: 'CARD-NOPE', research_gleanings_entry: 'x' });
    assert.equal(miss.ok, false);
    assert.match(miss.error, /^No card found for card_id CARD-NOPE -- nothing was written\.$/);
    const w1 = await call('write_commercial_card_fields', { card_id: CARD, research_gleanings_entry: 'G2', experiment_results_entry: 'E1', missing_research_resolved: false });
    assert.equal(w1.missing_research_count, 1, 'not resolved: no decrement');
    const w2 = await call('write_commercial_card_fields', { card_id: CARD, research_gleanings_entry: 'G3', missing_research_resolved: 'true' });
    assert.equal(w2.missing_research_count, 0);
    const wc = (await cardRow(CARD)).fields;
    assert.match(wc.research_gleanings, /\n\n\[[^\]]+Z\] G2\n\n\[[^\]]+Z\] G3$/);
    assert.match(wc.experiment_results, /^\[[^\]]+Z\] E1$/);
    const w3 = await call('write_commercial_card_fields', { card_id: CARD, missing_research_resolved: true });
    assert.equal(w3.missing_research_count, 0, 'never below nought');
    step('write_commercial_card_fields: ISO-stamped appends, decrement only when resolved, no card writes nothing');

    /* ---- compute_lane_state ---- */
    const none2 = await call('compute_lane_state', { card_id: CARD2, pilot_trigger: 'none' });
    assert.deepEqual([none2.lane_state, none2.pilot_state, none2.changed], ['research_first', 'research_only', false]);
    for (const [t, ls, ps] of [['ssv_started', 'pilot_running', 'pilot_live'], ['metrics_met', 'productized', 'pilot_success'], ['ended_no_threshold', 'needs_revision', 'pilot_failed']]) {
      const r = await call('compute_lane_state', { card_id: CARD2, pilot_trigger: t });
      assert.deepEqual([r.ok, r.lane_state, r.pilot_state], [true, ls, ps], t);
      const f = (await cardRow(CARD2)).fields;
      assert.deepEqual([f.lane_state, f.pilot_state], [ls, ps]);
    }
    const nc = await call('compute_lane_state', { card_id: 'CARD-NOPE', pilot_trigger: 'metrics_met' });
    assert.equal(nc.ok, false);
    assert.match(nc.error, /no state was changed/);
    step('compute_lane_state: the three transitions, none unchanged, no card writes nothing');

    /* ---- update_watched_client_question ---- */
    await seed('client_lanes', { fields: { 'Lane ID': `ZETA_TESTLANE_${S}`, 'Lane / Client': LANE_NAME, 'Questions Table': TABLE, 'Table ID': TABLE, 'Trend Shape Call': 'Early', 'Lane Status': 'warming_up' } });
    const QTEXT = `What is Zeta ${S} doing?`;
    const sq = await seed('client_questions', { record_id: QREC, table_id: TABLE, fields: { Question: QTEXT, 'This Week Answer': 'old answer', Confidence: 'high', 'Last Updated': '2026-09-14T08:00:00.000Z', 'Run Count': 1, 'Plain Summary': 'Keep me', 'Answer History': 'h0' } });
    assert.ok(sq.status < 300, JSON.stringify(sq.body));
    seen.bharag.length = 0;
    const u1 = await call('update_watched_client_question', {
      table_id: TABLE,
      question: QTEXT,
      answer: 'What the evidence supports:\nNew [S1]\n\nWhat it does not yet support:\nA gap.\n\nSources\n[S1] Src - https://s.example',
      plain_summary: '',
      confidence: 'medium',
      movement_tag: 'contradicted',
      sources: '["[S1] Src - https://s.example", "[S2] Two"]',
    });
    assert.equal(u1.ok, true, JSON.stringify(u1));
    assert.equal(u1.movement_tag, 'contradicted');
    assert.equal(u1.ingested_to_bharag, true);
    const qf = (await query(`SELECT fields FROM engine_client_questions WHERE airtable_record_id = $1`, [QREC])).rows[0].fields;
    assert.equal(qf['Plain Summary'], 'Keep me', 'an empty plain_summary keeps the previous one');
    assert.equal(qf['Contradicted From'], 'Previously (2026-09-14T08:00:00.000Z, confidence: high): old answer');
    assert.equal(qf.Sources, '[S1] Src - https://s.example || [S2] Two');
    assert.equal(qf['Movement Tag'], 'contradicted');
    assert.equal(qf['Research Stuck'], false);
    assert.equal(seen.bharag.length, 1);
    assert.equal(seen.bharag[0].path, '/ingest');
    assert.equal(seen.bharag[0].key, 'rt-key');
    assert.equal(seen.bharag[0].body.source_type, 'manual');
    assert.equal(seen.bharag[0].body.content_type, 'doc');
    assert.deepEqual(seen.bharag[0].body.project_tags, ['watched-clients', `unmapped-lane-${TABLE.toLowerCase()}`]);
    assert.match(seen.bharag[0].body.content, /This CONTRADICTS a previous answer/);
    bharagFails = true;
    const u2 = await call('update_watched_client_question', { table_id: TABLE, question: QTEXT, answer: 'second', confidence: 'low', movement_tag: 'same' });
    bharagFails = false;
    assert.equal(u2.ok, true, 'the row is written whatever BHARAG says');
    assert.equal(u2.ingested_to_bharag, false);
    assert.equal(u2.degraded, true);
    assert.equal((await query(`SELECT fields->>'This Week Answer' AS a FROM engine_client_questions WHERE airtable_record_id = $1`, [QREC])).rows[0].a, 'second');
    const nq = await call('update_watched_client_question', { table_id: TABLE, question: 'not a question here', answer: 'x' });
    assert.equal(nq.ok, false);
    assert.match(nq.error, /^No question row found matching that exact text in table /);
    step('update_watched_client_question: merge as UWC wrote it, BHARAG doc with the RT key, a BHARAG failure degrades and keeps the row');

    /* ---- create_client_report_doc ---- */
    const unknown = await call('create_client_report_doc', { client_name: 'Nobody Anywhere 999' });
    assert.equal(unknown.ok, false);
    assert.equal(unknown.reason, 'client_not_found');
    assert.ok(unknown.available.includes(LANE_NAME));
    seen.slack.length = 0;
    const rep = await call('create_client_report_doc', { client_name: `zeta testlane ${S}` });
    assert.equal(rep.ok, true, JSON.stringify(rep));
    assert.equal(rep.file_id, 'F0RTREPORT');
    assert.equal(rep.permalink, 'https://bha.slack.com/files/U0RT/F0RTREPORT/report.md');
    assert.equal(rep.question_count, 1);
    assert.match(rep.file_title, new RegExp(`^Weekly Watched Client Report — ${LANE_NAME} — \\d{4}-\\d{2}-\\d{2}$`));
    const paths = seen.slack.map((x) => x.path);
    assert.deepEqual(paths, ['/api/files.getUploadURLExternal', '/upload/v1/RT1', '/api/files.completeUploadExternal', '/api/files.info']);
    assert.equal(seen.slack[0].auth, 'Bearer xoxb-rt-test', 'as the Research Twin bot, never Bays');
    const form = new URLSearchParams(seen.slack[0].raw.toString('utf8'));
    const md = seen.slack[1].raw.toString('utf8');
    assert.equal(Number(form.get('length')), Buffer.byteLength(md, 'utf8'));
    assert.match(md, /^# Weekly Monitoring Report\n## Zeta Testlane/);
    const done = JSON.parse(seen.slack[2].raw.toString('utf8'));
    assert.equal(done.channel_id, 'C0B9LKU7DQV');
    assert.match(done.initial_comment, /^\*Weekly Monitoring Report\*\n\*Zeta Testlane \d+\*\n\n─{19}\n\n•  \*1\* questions tracked this week/);
    step('create_client_report_doc: built from live rows, uploaded as the RT bot to C0B9LKU7DQV with the initial_comment; unknown client named');

    /* ---- delete rt-asks ---- */
    const askId = `RT-TEST-${S}`;
    const sa = await seed('rt-asks', { fields: { 'Ask ID': askId, Question: 'delivery test' } });
    assert.ok(sa.status < 300, JSON.stringify(sa.body));
    const wrong = await call('delete_record', { kind: 'rt-asks', natural_id: askId, confirm: 'DELETE nope', reason: 'test' });
    assert.equal(wrong.ok, false);
    const del = await call('delete_record', { kind: 'rt-asks', natural_id: askId, confirm: `DELETE ${askId}`, reason: 'delivery test row' });
    assert.equal(del.deleted, true, JSON.stringify(del));
    assert.equal((await query(`SELECT count(*)::int AS n FROM engine_rt_asks WHERE natural_id = $1`, [askId])).rows[0].n, 0);
    assert.equal((await query(`SELECT count(*)::int AS n FROM record_deletions WHERE kind = 'rt-asks' AND natural_id = $1 AND reason = 'delivery test row'`, [askId])).rows[0].n, 1);
    step('delete_record: rt-asks deletable with the exact confirm, kept in record_deletions');

    /* ---- audit and the cap ---- */
    const audit = await query(`SELECT tool, outcome FROM engine_mcp_writes WHERE tool = ANY($1) ORDER BY id DESC LIMIT 200`, [['write_research_finding', 'write_commercial_card_fields', 'compute_lane_state', 'queue_followup_research', 'update_watched_client_question', 'create_client_report_doc']]);
    const tools6 = new Set(audit.rows.map((r) => r.tool));
    assert.equal(tools6.size, 6, 'every tool audited');
    assert.ok(!audit.rows.some((r) => r.outcome === 'pending'), 'none left pending');
    assert.ok(audit.rows.some((r) => r.outcome === 'refused') && audit.rows.some((r) => r.outcome === 'dry_run'));
    const big = rt.capAnswer({ ok: true, report_preview: 'x'.repeat(50_000), small: 'y' });
    assert.ok(JSON.stringify(big).length <= 20_000);
    assert.equal(big.truncated, true);
    assert.equal(big.small, 'y');
    step('every call on engine_mcp_writes, refusals and dry runs included; answers held to 20,000 characters');

    await query(`DELETE FROM engine_rt_jobs WHERE fields->>'Card ID' = $1`, [CARD]);
    await query(`DELETE FROM engine_commercial_cards WHERE natural_id = ANY($1)`, [[CARD, CARD2]]);
    await query(`DELETE FROM engine_client_questions WHERE table_id = $1`, [TABLE]);
    await query(`DELETE FROM engine_client_lanes WHERE natural_id = $1`, [`ZETA_TESTLANE_${S}`]);
    console.log(passed.map((p) => `  ✓ ${p}`).join('\n'));
    console.log(`test:research-twin — ${passed.length} checks passed`);
  } catch (e) {
    console.log(passed.map((p) => `  ✓ ${p}`).join('\n'));
    console.error(e);
    console.error(log.split('\n').slice(-40).join('\n'));
    process.exitCode = 1;
  } finally {
    server.kill();
    await closePool().catch(() => {});
    slack.close();
    bharagSrv.close();
  }
})();
