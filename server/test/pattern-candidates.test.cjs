/**
 * Acting on a pattern candidate from the Build patterns page (2026-09-24),
 * pinned end to end: the real server process behind a real sign-in, a local
 * database, and local stand-ins for Google and BHARAG.
 *
 *   register — through create_record's own path: BP- id minted, pattern saved,
 *     BHARAG ingested, Google Doc made; the candidate turns Registered with the
 *     Pattern ID, Registered At and Registered By; a second register is 409.
 *   decline — a reason is required; Status Declined with reason and who.
 *   reassign — to a Builder Profiles row only; Suggested Architect and
 *     Architect Slack ID both change; the same architect again is 409.
 *   who may act — the architect, the builder, Jason or Destiny; anyone else is
 *     403 and nothing is written; an actor with no profile is 400.
 *   the cookie — every action is refused without one.
 *   the audit — each write is on engine_mcp_writes with access 'page', and on
 *     engine_writes as endpoint page:<tool>.
 *   the handoff (2026-09-25) — a registered candidate is deleted, its whole
 *     row (Registered, Pattern ID) kept in record_deletions; a second register
 *     is 404.
 *   richer drafts — every other field on the candidate, the person's notes and
 *     a linked Codex entry go into the same prompt.
 *   MCP parity — draft_pattern_candidate and register_pattern_candidate on the
 *     write connection run the page's own code: same who-may-act rule, same
 *     model, same announcement and delete, logged as mcp:<tool>.
 *   the pipeline — draft runs per candidate (page and MCP counted together),
 *     time in Proposed, draft-to-register and decline rates, handed-off
 *     registrations read back from record_deletions.
 *
 * Every row it makes is deleted at the end. Run with:  npm run test:candidates
 * (needs a LOCAL DATABASE_URL)
 */
const assert = require('node:assert/strict');
const http = require('node:http');
const { spawn } = require('node:child_process');
const path = require('node:path');

if (!/@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL || '')) {
  console.error('test:candidates writes rows, so it only runs against a local DATABASE_URL (localhost or 127.0.0.1).');
  process.exit(1);
}

const PORT = 5081;
const TOKEN = 'candidates-test';
const T = Date.now();
const PASSWORD = 'candidate-test-password';
const ID = (s) => `UT${s}${String(T).slice(-6)}`;
const ARCH = ID('ARCH');
const BUILDER = ID('BLDR');
const OTHER = ID('OTHR');
const NEWARCH = ID('NEWA');
const DESTINY = 'U0AEW3TBYH1';

/* ------------------------------------------------------------ stand-ins */

const seen = { google: [], ingest: [] };
let docSeq = 0;
const google = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const u = new URL(req.url, 'http://x');
    seen.google.push({ method: req.method, path: u.pathname, body: body && body.startsWith('{') ? JSON.parse(body) : null });
    const send = (code, b) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(b));
    };
    if (u.pathname === '/token') return send(200, { access_token: 'ya29.test', expires_in: 3600 });
    if (u.pathname === '/drive/v3/files' && req.method === 'POST') return send(200, { id: `cdoc-${++docSeq}` });
    const m = /^\/v1\/documents\/([^:]+):batchUpdate$/.exec(u.pathname);
    if (m) return send(200, { documentId: m[1] });
    const f = /^\/drive\/v3\/files\/([^/]+)$/.exec(u.pathname);
    if (f) return send(200, { id: f[1], webViewLink: `https://docs.google.com/document/d/${f[1]}/edit` });
    return send(404, { error: { message: `no route ${u.pathname}` } });
  });
});
const bharag = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    seen.ingest.push({ path: req.url, key: req.headers['x-api-key'], body: body ? JSON.parse(body) : null });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ document_id: `bh-${seen.ingest.length}` }));
  });
});
/*
 * Slack: conversations.replies (the thread, read as North Star), and
 * chat.postMessage / chat.getPermalink / chat.delete (the announcement, as
 * Bays). A channel in failPost refuses the post the way Slack does: HTTP 200,
 * ok:false.
 */
seen.slack = [];
const posts = new Map();
let failPost = null;
const THREAD = [
  { user: 'U0BNQGG020Y', ts: '1790000000.000100', text: 'Rover stepper: the Python pulse loop tops out at 3400 steps/s, <@U0AEW3TBYH1> the spec is 4000.' },
  { user: 'U0AEW3TBYH1', ts: '1790000100.000200', text: 'Moved pulse generation to pigpio DMA; 100% commanded-vs-actual at 2, 5, 10, 20 and 40 mm/s.' },
  { bot_id: 'B1', bot_profile: { name: 'Bays' }, ts: '1790000200.000300', text: 'Flagged as a pattern candidate.' },
];
const slackSrv = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const u = new URL(req.url, 'http://x');
    const method = u.pathname.replace(/^\/api\//, '');
    let args = Object.fromEntries(u.searchParams);
    if (body) args = { ...args, ...((req.headers['content-type'] || '').includes('json') ? JSON.parse(body) : Object.fromEntries(new URLSearchParams(body))) };
    seen.slack.push({ method, auth: req.headers.authorization, args });
    const send = (b) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(b));
    };
    if (method === 'conversations.replies') {
      if (args.channel === 'CNOTMEMBER') return send({ ok: false, error: 'not_in_channel' });
      return send({ ok: true, messages: THREAD });
    }
    if (method === 'chat.postMessage') {
      if (failPost && args.channel === failPost) return send({ ok: false, error: 'not_in_channel' });
      const ts = `${Math.floor(Date.now() / 1000)}.${String(posts.size + 1).padStart(6, '0')}`;
      posts.set(ts, args);
      return send({ ok: true, channel: args.channel, ts });
    }
    if (method === 'chat.getPermalink') return send({ ok: true, permalink: `https://bayshorizonnetwork.slack.com/archives/${args.channel}/p${String(args.message_ts).replace('.', '')}` });
    if (method === 'chat.delete') return send(posts.delete(args.ts) ? { ok: true } : { ok: false, error: 'message_not_found' });
    return send({ ok: false, error: 'unknown_method' });
  });
});
/* OpenRouter: records the request and answers with a draft that leaves some fields empty, as a grounded draft does. */
let modelAnswer = null;
const openrouter = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    seen.model = { auth: req.headers.authorization, path: req.url, body: JSON.parse(body) };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: '```json\n' + JSON.stringify(modelAnswer) + '\n```\n' } }], usage: { total_tokens: 1234 } }));
  });
});
const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${s.address().port}`)));

/* ------------------------------------------------------------ the client */

let cookie = '';
function request(method, pathname, payload, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: PORT, path: pathname, method, headers: { 'content-type': 'application/json', accept: 'application/json', ...(cookie ? { cookie } : {}), ...headers } },
      (res) => {
        let b = '';
        res.on('data', (c) => (b += c));
        res.on('end', () => {
          let body = null;
          try {
            body = b ? JSON.parse(b) : null;
          } catch {
            body = b;
          }
          resolve({ status: res.statusCode, body, headers: res.headers });
        });
      },
    );
    req.on('error', reject);
    req.end(payload === undefined ? undefined : JSON.stringify(payload));
  });
}
async function mcp(name, args) {
  const r = await request('POST', `/mcp/${TOKEN}`, { jsonrpc: '2.0', id: Date.now(), method: 'tools/call', params: { name, arguments: args } }, { cookie: '' });
  return JSON.parse(r.body.result.content[0].text);
}
const act = (ref, action, body) => request('POST', `/api/pattern-candidates/${encodeURIComponent(ref)}/${action}`, body);

(async () => {
  const [googleUrl, bharagUrl, slackUrl, orUrl] = await Promise.all([listen(google), listen(bharag), listen(slackSrv), listen(openrouter)]);
  const { hashPassword } = require(path.join(__dirname, '../../server-dist/server/src/auth.js'));
  const env = {
    ...process.env,
    PORT: String(PORT),
    MCP_SECRET: TOKEN,
    MCP_WRITE_TOKEN: TOKEN,
    DASHBOARD_INBOUND_KEY: 'inbound-for-test',
    RECOVERY_ENABLED: 'false',
    AUTH_EMAIL: 'test@bhanetwork.org',
    AUTH_PASSWORD_HASH: hashPassword(PASSWORD),
    SESSION_SECRET: 'candidates-session-secret',
    GOOGLE_API_URL: googleUrl,
    GOOGLE_OAUTH_CLIENT_ID: 'cid',
    GOOGLE_OAUTH_CLIENT_SECRET: 'csecret',
    GOOGLE_OAUTH_REFRESH_TOKEN: 'rtoken',
    BHARAG_API_URL: bharagUrl,
    BHARAG_BUILD_PATTERNS_KEY: 'bp-key',
    SLACK_API_URL: `${slackUrl}/api`,
    SLACK_BAYS_BOT_TOKEN: 'xoxb-bays',
    SLACK_NORTH_STAR_BOT_TOKEN: 'xoxb-northstar',
    OPENROUTER_API_URL: orUrl,
    OPENROUTER_API_KEY: 'sk-or-test',
  };
  for (const k of ['GOOGLE_SERVICE_ACCOUNT_JSON', 'AUTH_PASSWORD']) delete env[k];
  const server = spawn(process.execPath, ['--no-warnings=ExperimentalWarning', path.join(__dirname, '../../server-dist/server/src/index.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  server.stdout.on('data', (c) => (log += c));
  server.stderr.on('data', (c) => (log += c));
  for (let i = 0; i < 80; i++) {
    await new Promise((r) => setTimeout(r, 250));
    if (/listening|http:\/\//i.test(log) && (await request('GET', '/api/auth/session').catch(() => null))) break;
  }
  const { query, closePool } = require('../../server-dist/server/src/pg.js');
  const made = { profiles: [], candidates: [], patterns: [] };
  const passed = [];
  const step = (s) => passed.push(s);

  try {
    /* ---- the cookie ---- */
    const noCookie = await act('CAND-x', 'decline', { actor_user_id: DESTINY, reason: 'nope' });
    assert.equal(noCookie.status, 401, 'refused without a session');
    const login = await request('POST', '/api/auth/login', { email: 'test@bhanetwork.org', password: PASSWORD });
    assert.equal(login.status, 200, JSON.stringify(login.body));
    cookie = String(login.headers['set-cookie'][0]).split(';')[0];
    step('actions are behind the page cookie');

    /* ---- throwaway profiles and candidates ---- */
    const hadDestiny = (await query(`SELECT count(*)::int n FROM engine_builder_profiles WHERE natural_id = $1`, [DESTINY])).rows[0].n > 0;
    for (const [id, name] of [[ARCH, `Arch ${T}`], [BUILDER, `Builder ${T}`], [OTHER, `Other ${T}`], [NEWARCH, `New Arch ${T}`], ...(hadDestiny ? [] : [[DESTINY, 'Destiny Arupi']])]) {
      const p = await mcp('create_record', { kind: 'builder_profiles', fields: { user_id: id, name, pronouns: 'they/them', lane: 'BAYS', role: 'builder' } });
      assert.equal(p.ok, true, JSON.stringify(p));
      made.profiles.push(id);
    }
    const profiles = await request('GET', '/api/builder-profiles');
    assert.ok(profiles.body.profiles.some((p) => p.user_id === ARCH && p.name === `Arch ${T}`), 'the picker reads Builder Profiles');

    const mk = async (label, source = 'https://bha.slack.com/archives/C0/p1', extra = {}) => {
      const c = await mcp('create_record', {
        kind: 'pattern_candidates',
        fields: {
          Candidate: `Throwaway ${label} ${T}`,
          Summary: `A throwaway candidate for the page-action test (${label}).`,
          Lane: 'BAYS',
          Builder: `Builder ${T}`,
          'Builder Slack ID': BUILDER,
          'Suggested Architect': `Arch ${T}`,
          'Architect Slack ID': ARCH,
          'Why This Architect': 'Did the work.',
          'Flagged By': 'test',
          'Source Link': source,
          ...extra,
        },
      });
      assert.equal(c.ok, true, JSON.stringify(c));
      made.candidates.push(c.natural_id);
      return c.natural_id;
    };
    const [cReg, cDec, cRea] = [await mk('register'), await mk('decline'), await mk('reassign')];
    const listed = await request('GET', '/api/pattern-candidates');
    const row = listed.body.candidates.find((c) => c.id === cReg);
    assert.ok(row, 'the page lists the candidate by its CAND- id');
    assert.equal(row.status, 'Proposed');
    assert.equal(row.architect_slack_id, ARCH);
    step('throwaway profiles and candidates seeded');

    /* ---- who may act ---- */
    const auditFrom = (await query(`SELECT coalesce(max(id),0)::int m FROM engine_mcp_writes`)).rows[0].m;
    const before = (await query(`SELECT count(*)::int n FROM engine_mcp_writes WHERE access = 'page'`)).rows[0].n;
    const other = await act(cDec, 'decline', { actor_user_id: OTHER, reason: 'not mine to decline' });
    assert.equal(other.status, 403);
    assert.equal(other.body.reason, 'not_permitted');
    assert.match(other.body.message, /only its suggested architect/);
    const nobody = await act(cDec, 'decline', { actor_user_id: 'UNOPROFILE1', reason: 'who am I' });
    assert.equal(nobody.status, 400);
    assert.equal(nobody.body.reason, 'unknown_actor');
    const noActor = await act(cDec, 'decline', { reason: 'who am I' });
    assert.equal(noActor.body.reason, 'no_actor');
    assert.equal((await query(`SELECT count(*)::int n FROM engine_mcp_writes WHERE access = 'page'`)).rows[0].n, before, 'a refused actor writes nothing, not even an audit line');
    step('only the architect, the builder, Jason or Destiny may act');

    /* ---- decline ---- */
    const noReason = await act(cDec, 'decline', { actor_user_id: ARCH, reason: ' x ' });
    assert.equal(noReason.status, 400);
    assert.equal(noReason.body.reason, 'no_reason');
    const dec = await act(cDec, 'decline', { actor_user_id: BUILDER, reason: 'Already covered by an existing pattern.' });
    assert.equal(dec.status, 200, JSON.stringify(dec.body));
    const decRow = (await query(`SELECT fields FROM engine_pattern_candidates WHERE natural_id = $1`, [cDec])).rows[0].fields;
    assert.equal(decRow.Status, 'Declined');
    assert.equal(decRow['Declined Reason'], 'Already covered by an existing pattern.');
    assert.equal(decRow['Declined By'], `Builder ${T}`);
    assert.equal(decRow['Declined By Slack ID'], BUILDER);
    assert.ok(decRow['Declined At']);
    assert.equal(decRow.Summary, 'A throwaway candidate for the page-action test (decline).', 'every other field kept');
    const again = await act(cDec, 'decline', { actor_user_id: ARCH, reason: 'twice' });
    assert.equal(again.status, 409);
    assert.equal(again.body.reason, 'already_declined');
    const decPage = (await request('GET', '/api/pattern-candidates')).body.candidates.find((c) => c.id === cDec);
    assert.deepEqual([decPage.status, decPage.declined_reason, decPage.declined_by], ['Declined', 'Already covered by an existing pattern.', `Builder ${T}`]);
    step('decline: reason required, Declined with reason and who, then closed');

    /* ---- reassign ---- */
    const bad = await act(cRea, 'reassign', { actor_user_id: ARCH, architect_user_id: 'UNOPROFILE1' });
    assert.equal(bad.body.reason, 'unknown_architect');
    const same = await act(cRea, 'reassign', { actor_user_id: ARCH, architect_user_id: ARCH });
    assert.equal(same.status, 409);
    const rea = await act(cRea, 'reassign', { actor_user_id: DESTINY, architect_user_id: NEWARCH });
    assert.equal(rea.status, 200, JSON.stringify(rea.body));
    assert.equal(rea.body.suggested_architect, `New Arch ${T}`);
    const reaRow = (await query(`SELECT fields FROM engine_pattern_candidates WHERE natural_id = $1`, [cRea])).rows[0].fields;
    assert.deepEqual([reaRow['Suggested Architect'], reaRow['Architect Slack ID'], reaRow['Reassigned By'], reaRow.Status], [`New Arch ${T}`, NEWARCH, 'Destiny Arupi', 'Proposed']);
    const oldArch = await act(cRea, 'decline', { actor_user_id: ARCH, reason: 'I was the architect' });
    assert.equal(oldArch.status, 403, 'the previous architect no longer may act');
    step('reassign: from Builder Profiles only, both fields change, the old architect loses the right');

    /* ---- register ---- */
    const reg = await act(cReg, 'register', {
      actor_user_id: ARCH,
      pattern: {
        pattern_name: `Throwaway register ${T}`,
        bha_system: 'BAYS',
        reusability: 'Moderate',
        problem: 'The problem.',
        solution: 'The solution.',
        context: 'The context.',
        implementation_checklist: 'Step one\nStep two\n',
      },
    });
    assert.equal(reg.status, 200, JSON.stringify(reg.body));
    assert.match(reg.body.pattern_id, /^BP-BAYS-\d+-[A-Z0-9]{4}$/);
    made.patterns.push(reg.body.pattern_id);
    assert.equal(reg.body.candidate_updated, true);
    assert.equal(reg.body.ingested_to_bharag, true);
    assert.equal(reg.body.doc_created, true);
    assert.match(reg.body.doc_link, /^https:\/\/docs\.google\.com\/document\/d\/cdoc-/);
    const pat = (await query(`SELECT fields, source FROM engine_build_patterns WHERE natural_id = $1`, [reg.body.pattern_id])).rows[0];
    assert.equal(pat.source, 'engine');
    assert.equal(pat.fields.pattern_name, `Throwaway register ${T}`);
    const docCreate = seen.google.filter((g) => g.path === '/drive/v3/files' && g.method === 'POST').at(-1);
    assert.equal(docCreate.body.name, `Build Pattern -- Throwaway register ${T} -- Arch ${T}`, 'drafted_by is the person acting, on the Doc');
    assert.equal(pat.fields.implementation_checklist, 'Step one | Step two', 'one step per line joined as patterns are');
    assert.equal(seen.ingest.at(-1).key, 'bp-key');
    assert.equal(seen.ingest.at(-1).body.metadata.pattern_id, reg.body.pattern_id);
    assert.equal(reg.body.candidate_deleted, true, JSON.stringify(reg.body));
    assert.equal((await query(`SELECT count(*)::int n FROM engine_pattern_candidates WHERE natural_id = $1`, [cReg])).rows[0].n, 0, 'the candidate row is gone from the list');
    const kept = (await query(`SELECT fields, reason FROM record_deletions WHERE kind = 'pattern_candidates' AND natural_id = $1`, [cReg])).rows;
    assert.equal(kept.length, 1, 'the whole row kept in record_deletions');
    const regRow = kept[0].fields;
    assert.match(kept[0].reason, new RegExp(`^Registered as ${reg.body.pattern_id} by Arch ${T}`));
    assert.deepEqual([regRow.Status, regRow['Pattern ID'], regRow['Registered By']], ['Registered', reg.body.pattern_id, `Arch ${T}`], 'marked before it was deleted');
    assert.ok(regRow['Registered At']);
    assert.equal(regRow.Summary, 'A throwaway candidate for the page-action test (register).', 'every other field kept in the copy');
    assert.equal((await request('GET', '/api/pattern-candidates')).body.candidates.some((c) => c.id === cReg), false, 'the page no longer lists it');
    const delAudit = (await query(`SELECT outcome, access FROM engine_mcp_writes WHERE tool = 'delete_record' AND natural_id = $1`, [cReg])).rows;
    assert.deepEqual(delAudit, [{ outcome: 'deleted', access: 'page' }]);
    const twice = await act(cReg, 'register', { actor_user_id: ARCH, pattern: { pattern_name: 'again' } });
    assert.equal(twice.status, 404, 'a handed-off candidate cannot be registered twice');
    assert.equal(twice.body.reason, 'not_found');
    made.candidates = made.candidates.filter((x) => x !== cReg);
    step('register: BP- id, pattern saved, BHARAG ingested, Doc made, candidate marked Registered then deleted (kept in record_deletions)');

    /* ---- the announcement ---- */
    const annPost = seen.slack.filter((x) => x.method === 'chat.postMessage').at(-1);
    assert.equal(reg.body.announced, true, JSON.stringify(reg.body));
    assert.equal(annPost.auth, 'Bearer xoxb-bays', 'posted as Bays');
    assert.equal(annPost.args.channel, 'C0B0668PRNW', 'into #bha-build-patterns');
    const cardText = JSON.stringify(annPost.args.blocks);
    assert.equal(annPost.args.blocks[0].text.text, '🔧 BHA Build Pattern', 'the extractor card header');
    assert.match(cardText, new RegExp(`From \\*Builder ${T}\\*`), 'the builder whose work it came from');
    assert.match(cardText, new RegExp(`\\*Throwaway register ${T}\\*`), 'the pattern name');
    assert.match(cardText, new RegExp(`\\*Pattern ID:\\* \`${reg.body.pattern_id}\``), 'the BP- id');
    assert.match(cardText, /The problem\./, 'the one-line problem');
    assert.match(cardText, new RegExp(`Registered by <@${ARCH}>`), 'who registered it, as a mention');
    assert.match(cardText, /<https:\/\/docs\.google\.com\/document\/d\/cdoc-[^|]+\|Google Doc>/, 'the Doc link');
    assert.match(cardText, new RegExp(`/build-patterns\\?open=row-${reg.body.pattern_row_id}\\|Full pattern on the dashboard>`), 'the pattern on the dashboard');
    assert.equal(reg.body.pattern_url.endsWith(`/build-patterns?open=row-${reg.body.pattern_row_id}`), true);
    assert.match(reg.body.announcement_link, /^https:\/\/bayshorizonnetwork\.slack\.com\/archives\/C0B0668PRNW\/p\d+/);
    assert.equal(regRow['Announcement Link'], reg.body.announcement_link, 'the candidate carries its announcement');
    const annAudit = (await query(`SELECT outcome, access, kind FROM engine_mcp_writes WHERE tool = 'announce_pattern' AND natural_id = $1`, [reg.body.pattern_id])).rows;
    assert.deepEqual(annAudit, [{ outcome: 'posted', access: 'page', kind: 'slack' }]);
    step('announce: one Bays post in #bha-build-patterns — name, BP- id, problem, <@registrar>, builder, Doc, dashboard link');

    /* ---- draft full pattern ---- */
    // A Codex entry the candidate names: read as a source of its own (2026-09-25).
    const CODEX = `CODEX-20260925-test-stepper-dma-${T}`;
    const SUB = `UTSUB_${T}`;
    await query(
      `INSERT INTO engine_codex_submissions (natural_id, builder_id, fields, source, first_seen_at, updated_at) VALUES ($1, 'kavin', $2::jsonb, 'engine', now()::text, now()::text)`,
      [SUB, JSON.stringify({ 'Submission ID': SUB, 'Codex Entry ID': CODEX, 'Builder Name': 'Kavin', 'Session Type': 'build', Summary: 'Moved the Rover stepper to DMA pulses.', 'Orchestrator Layer2 Review': 'LAYER2: measured 3400 steps/s ceiling on the Python loop; pigpio wave chains fixed it.' })],
    );
    const cDraft = await mk('draft', 'https://bayshorizonnetwork.slack.com/archives/C0A90TS44T1/p1790000100000200?thread_ts=1790000000.000100&cid=C0A90TS44T1', {
      Notes: 'Also applies to the kiosk motor.',
      'Codex Entry ID': CODEX,
    });
    modelAnswer = {
      pattern_name: 'DMA pulse generation for stepper accuracy',
      problem: 'A Python pulse loop tops out at 3400 steps per second against a 4000 step requirement.',
      solution: 'Generate pulses with the Raspberry Pi DMA engine through pigpio.',
      context: 'vFarm Rover stepper axis.',
      bha_system: 'VFARM',
      reusability: 'broad — any motion axis',
      implementation_checklist: ['Measure the loop overhead per step', 'Switch pulse generation to pigpio DMA'],
      learnings_gotchas: '',
      anti_pattern: 'Anti-Pattern: running a software pulse loop when its overhead exceeds the step period.',
      integration_points: '',
      readiness_gates: '',
      next_use_case: '',
      commercial_impact: '',
      research_production_impact: '',
      routing_logic: '',
      test_coverage: '100% commanded-vs-actual at 2, 5, 10, 20 and 40 mm/s.',
      naming_note: '',
      roadmap_context: '',
      pattern_id: 'BP-MODEL-SHOULD-NOT-PICK',
      observability: 'not asked for',
    };
    const otherDraft = await act(cDraft, 'draft', { actor_user_id: OTHER });
    assert.equal(otherDraft.status, 403, 'a draft follows the same who-may-act rule');
    const d = await act(cDraft, 'draft', { actor_user_id: BUILDER });
    assert.equal(d.status, 200, JSON.stringify(d.body));
    assert.equal(seen.model.auth, 'Bearer sk-or-test');
    assert.equal(seen.model.path, '/chat/completions');
    assert.equal(seen.model.body.model, 'anthropic/claude-sonnet-5', "the model the agents and the Pattern Extractor use");
    assert.equal(seen.model.body.max_tokens, 3000);
    assert.deepEqual(seen.model.body.response_format, { type: 'json_object' });
    const [sys, usr] = seen.model.body.messages;
    assert.match(sys.content, /You are the Bays Horizon Build-Pattern Extractor/, "the extractor's prompt");
    assert.match(sys.content, /A field the sources do not support is an empty string/, 'the never-invent rule');
    assert.doesNotMatch(sys.content, /pattern_id:/, 'pattern_id is minted, not asked for');
    assert.match(usr.content, /A throwaway candidate for the page-action test \(draft\)\./, 'the Summary is a source');
    assert.match(usr.content, /Kavin: Rover stepper: the Python pulse loop tops out at 3400 steps\/s, @Destiny Arupi the spec is 4000\./, 'the thread is a source, names and mentions cleaned');
    assert.match(usr.content, /OTHER FIELDS ON THE CANDIDATE:[\s\S]*Notes: Also applies to the kiosk motor\./, "the candidate's other fields are a source");
    assert.match(usr.content, /Flagged By: test/, 'Flagged By too');
    assert.doesNotMatch(usr.content, /Architect Slack ID|Builder Slack ID/, 'bookkeeping is not a source');
    assert.match(usr.content, /CODEX ENTRY[\s\S]*LAYER2: measured 3400 steps\/s ceiling/, 'the Codex entry the candidate names is read');
    assert.match(usr.content, /NOTES FROM THE PERSON DRAFTING:\n\(none\)/, 'no notes sent, and the prompt says so');
    assert.match(sys.content, /A source marked "\(none\)" or "\(not read: \.\.\.\)" contributes nothing/, 'an absent source is not a fact');
    assert.deepEqual(d.body.sources.codex.found, [CODEX]);
    assert.ok(d.body.sources.other_fields.includes('Notes'));
    const replies = seen.slack.filter((x) => x.method === 'conversations.replies').at(-1);
    assert.deepEqual([replies.auth, replies.args.channel, replies.args.ts], ['Bearer xoxb-northstar', 'C0A90TS44T1', '1790000000.000100'], 'the thread root, read as North Star');
    assert.equal(d.body.sources.thread.read, true);
    assert.equal(d.body.sources.thread.messages, 3);
    assert.equal(d.body.fields.implementation_checklist, 'Measure the loop overhead per step\nSwitch pulse generation to pigpio DMA', 'the checklist one step per line');
    assert.equal(d.body.fields.reusability, 'Broad', 'reusability normalised to the three values');
    assert.equal(d.body.fields.learnings_gotchas, '', 'an unsupported field stays empty');
    assert.ok(d.body.empty_fields.includes('integration_points') && d.body.empty_fields.includes('readiness_gates'));
    assert.equal('pattern_id' in d.body.fields, false, "the model's pattern_id is dropped");
    assert.equal('observability' in d.body.fields, false, 'a field no page shows is not drafted');
    assert.match(d.body.note, /Nothing is saved until you press Register/);
    assert.equal((await query(`SELECT count(*)::int n FROM engine_build_patterns WHERE fields->>'pattern_name' = $1`, ['DMA pulse generation for stepper accuracy'])).rows[0].n, 0, 'a draft saves nothing');
    assert.equal((await query(`SELECT fields->>'Status' s FROM engine_pattern_candidates WHERE natural_id = $1`, [cDraft])).rows[0].s, 'Proposed', 'the candidate is untouched');
    const draftLog = (await query(`SELECT outcome, detail FROM engine_writes WHERE endpoint = 'page:draft_pattern' AND natural_id = $1`, [cDraft])).rows;
    assert.equal(draftLog.length, 1);
    assert.equal(draftLog[0].outcome, 'read');
    assert.match(draftLog[0].detail, /thread 3 messages; codex CODEX-/);

    const unread = await mk('draft unread', 'https://bayshorizonnetwork.slack.com/archives/CNOTMEMBER/p1790000000000100');
    const d2 = await act(unread, 'draft', { actor_user_id: ARCH });
    assert.equal(d2.status, 200);
    assert.equal(d2.body.sources.thread.read, false);
    assert.match(d2.body.sources.thread.note, /not_in_channel — the North Star bot is not in that channel/);
    assert.match(d2.body.note, /the thread was not read/, 'a draft from the Summary alone says so');
    assert.match(seen.model.body.messages[1].content, /CODEX ENTRY[^\n]*\n\(none linked\)/, 'no Codex entry named, and the prompt says so');
    assert.match(seen.model.body.messages[1].content, /\(not read: Slack refused conversations\.replies: not_in_channel/);
    step('draft: the extractor’s model and prompt, Summary + thread (as North Star), unsupported fields empty, nothing saved');

    /* ---- register the draft, with the announcement refused ---- */
    failPost = 'C0B0668PRNW';
    const full = { ...d.body.fields, pattern_name: `Throwaway drafted ${T}`, learnings_gotchas: 'Edited by the architect before registering.' };
    const reg2 = await act(cDraft, 'register', { actor_user_id: BUILDER, pattern: full });
    failPost = null;
    assert.equal(reg2.status, 200, JSON.stringify(reg2.body));
    made.patterns.push(reg2.body.pattern_id);
    assert.match(reg2.body.pattern_id, /^BP-VFARM-\d+-[A-Z0-9]{4}$/);
    assert.equal(reg2.body.announced, false);
    assert.match(reg2.body.announcement_error, /not_in_channel — Bays is not a member of #bha-build-patterns/);
    assert.equal(reg2.body.candidate_updated, true, 'a failed post never undoes the registration');
    assert.equal(reg2.body.doc_created, true);
    assert.equal(reg2.body.ingested_to_bharag, true);
    const pat2 = (await query(`SELECT fields FROM engine_build_patterns WHERE natural_id = $1`, [reg2.body.pattern_id])).rows[0].fields;
    assert.equal(pat2.anti_pattern, full.anti_pattern, 'every drafted field is stored');
    assert.equal(pat2.test_coverage, full.test_coverage);
    assert.equal(pat2.learnings_gotchas, 'Edited by the architect before registering.', 'what was edited is what is stored');
    assert.equal(pat2.implementation_checklist, 'Measure the loop overhead per step | Switch pulse generation to pigpio DMA');
    assert.equal('integration_points' in pat2, false, 'an empty field is not written as an empty string');
    assert.equal(reg2.body.candidate_deleted, true);
    made.candidates = made.candidates.filter((x) => x !== cDraft);
    const r2 = (await query(`SELECT fields FROM record_deletions WHERE kind = 'pattern_candidates' AND natural_id = $1`, [cDraft])).rows[0].fields;
    assert.deepEqual([r2.Status, r2['Pattern ID'], r2['Announcement Link']], ['Registered', reg2.body.pattern_id, undefined]);
    const failAudit = (await query(`SELECT outcome, detail FROM engine_mcp_writes WHERE tool = 'announce_pattern' AND natural_id = $1`, [reg2.body.pattern_id])).rows;
    assert.equal(failAudit[0].outcome, 'failed');
    assert.match(failAudit[0].detail, /not_in_channel/);
    step('register a draft: every field stored as edited; a refused post is reported and audited, the registration stands');

    /* ---- MCP parity: the same draft and register, over the write connection ---- */
    const writeList = (await request('POST', `/mcp/${TOKEN}`, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { cookie: '' })).body.result.tools;
    for (const name of ['draft_pattern_candidate', 'register_pattern_candidate']) {
      const t = writeList.find((x) => x.name === name);
      assert.ok(t, `${name} is on the write connection`);
      assert.ok(t.annotations && typeof t.annotations.readOnlyHint === 'boolean', `${name} carries annotations`);
    }
    const cMcp = await mk('mcp', 'https://bayshorizonnetwork.slack.com/archives/C0A90TS44T1/p1790000000000100');
    const mOther = await mcp('draft_pattern_candidate', { candidate: cMcp, requester_user_id: OTHER });
    assert.deepEqual([mOther.ok, mOther.status, mOther.reason], [false, 403, 'not_permitted'], 'the same who-may-act rule, as ok:false');
    const mNobody = await mcp('register_pattern_candidate', { candidate: cMcp, requester_user_id: 'UNOPROFILE1' });
    assert.equal(mNobody.reason, 'unknown_actor');
    const md = await mcp('draft_pattern_candidate', { candidate: cMcp, requester_user_id: ARCH, notes: 'Bays heard in Slack: the kiosk motor needs it too.', codex_entry_id: SUB });
    assert.equal(md.ok, true, JSON.stringify(md));
    assert.equal(seen.model.body.model, 'anthropic/claude-sonnet-5', 'the same model');
    assert.match(seen.model.body.messages[0].content, /You are the Bays Horizon Build-Pattern Extractor/, 'the same prompt');
    assert.match(seen.model.body.messages[1].content, /NOTES FROM THE PERSON DRAFTING:\nBays heard in Slack: the kiosk motor needs it too\./, 'notes passed over MCP are a source');
    assert.match(seen.model.body.messages[1].content, /LAYER2: measured/, 'a Codex entry named by Submission ID is read');
    assert.equal(md.sources.notes, true);
    const mdLog = (await query(`SELECT outcome, key_label FROM engine_writes WHERE endpoint = 'mcp:draft_pattern_candidate' AND natural_id = $1`, [cMcp])).rows;
    assert.deepEqual(mdLog, [{ outcome: 'read', key_label: 'MCP_WRITE_TOKEN' }], 'logged as the MCP door');
    assert.equal((await query(`SELECT count(*)::int n FROM engine_build_patterns WHERE fields->>'pattern_name' = $1`, [md.fields.pattern_name])).rows[0].n, 0, 'an MCP draft saves nothing');

    // A second draft of the same candidate from the page: one count per candidate, both doors together.
    await act(cMcp, 'draft', { actor_user_id: ARCH });
    // OPENROUTER unset is not tested here (the server holds the key); a failed draft is counted apart.
    const dry = await mcp('register_pattern_candidate', { candidate: cMcp, requester_user_id: ARCH, fields: { ...md.fields, pattern_name: `Throwaway mcp dry ${T}` }, dry_run: true });
    assert.equal(dry.dry_run, true, JSON.stringify(dry));
    assert.equal((await query(`SELECT count(*)::int n FROM engine_pattern_candidates WHERE natural_id = $1`, [cMcp])).rows[0].n, 1, 'a dry run deletes nothing');

    const postsBefore = seen.slack.filter((x) => x.method === 'chat.postMessage').length;
    const auditMark = (await query(`SELECT coalesce(max(id),0)::int m FROM engine_mcp_writes`)).rows[0].m;
    const mr = await mcp('register_pattern_candidate', { candidate: cMcp, requester_user_id: DESTINY, fields: { ...md.fields, pattern_name: `Throwaway mcp ${T}`, implementation_checklist: ['One', 'Two'] } });
    assert.equal(mr.ok, true, JSON.stringify(mr));
    made.patterns.push(mr.pattern_id);
    assert.match(mr.pattern_id, /^BP-VFARM-\d+-[A-Z0-9]{4}$/);
    assert.deepEqual([mr.ingested_to_bharag, mr.doc_created, mr.announced, mr.candidate_updated, mr.candidate_deleted], [true, true, true, true, true], 'the same effect as the button');
    assert.equal(seen.slack.filter((x) => x.method === 'chat.postMessage').length, postsBefore + 1, 'one announcement');
    const mPat = (await query(`SELECT fields FROM engine_build_patterns WHERE natural_id = $1`, [mr.pattern_id])).rows[0].fields;
    assert.equal(mPat.implementation_checklist, 'One | Two');
    const mKept = (await query(`SELECT fields FROM record_deletions WHERE kind = 'pattern_candidates' AND natural_id = $1`, [cMcp])).rows[0].fields;
    assert.deepEqual([mKept.Status, mKept['Pattern ID'], mKept['Registered By']], ['Registered', mr.pattern_id, 'Destiny Arupi']);
    const mAudit = (await query(`SELECT tool, access FROM engine_mcp_writes WHERE natural_id = ANY($1) AND access = 'write' AND tool IN ('create_record','update_record','delete_record') AND id > $2 ORDER BY id`, [[cMcp, mr.pattern_id], auditMark])).rows.map((a) => a.tool);
    assert.deepEqual(mAudit, ['create_record', 'update_record', 'delete_record'], 'audited at access write, through the same handlers');
    const mAnn = (await query(`SELECT access FROM engine_mcp_writes WHERE tool = 'announce_pattern' AND natural_id = $1`, [mr.pattern_id])).rows;
    assert.deepEqual(mAnn, [{ access: 'write' }]);
    made.candidates = made.candidates.filter((x) => x !== cMcp);

    // Register with no fields: the page form's seed — name, Summary, lane.
    const cPlain = await mk('plain');
    const mp = await mcp('register_pattern_candidate', { candidate: cPlain, requester_user_id: BUILDER });
    assert.equal(mp.ok, true, JSON.stringify(mp));
    made.patterns.push(mp.pattern_id);
    const plain = (await query(`SELECT fields FROM engine_build_patterns WHERE natural_id = $1`, [mp.pattern_id])).rows[0].fields;
    assert.deepEqual([plain.pattern_name, plain.problem, plain.bha_system, plain.reusability], [`Throwaway plain ${T}`, 'A throwaway candidate for the page-action test (plain).', 'BAYS', 'Moderate']);
    made.candidates = made.candidates.filter((x) => x !== cPlain);
    // The OpenRouter gate is the page's: unset, not_configured, naming the variable (checked in-process, where the key can be unset).
    const drafter = require('../../server-dist/server/src/patternDraft.js');
    const heldKey = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    await assert.rejects(drafter.draft({ id: 1, natural_id: 'CAND-x', airtable_record_id: null, fields: {} }), (e) => e.reason === 'not_configured' && /OPENROUTER_API_KEY is not set/.test(e.message));
    if (heldKey !== undefined) process.env.OPENROUTER_API_KEY = heldKey;
    step('MCP: draft_pattern_candidate and register_pattern_candidate run the page’s own path — rule, model, notes, Codex, announcement, delete — logged as mcp:');

    /* ---- the pipeline figures ---- */
    const pg = (await request('GET', '/api/pattern-candidates')).body;
    const p = pg.pipeline;
    assert.ok(p, 'the page payload carries the pipeline');
    const handed = (await query(`SELECT count(DISTINCT coalesce(natural_id, record_id))::int n FROM record_deletions WHERE kind = 'pattern_candidates' AND reason LIKE 'Registered as %'`)).rows[0].n;
    assert.equal(p.handed_off, handed, 'handed-off registrations read back from record_deletions');
    const liveRows = pg.candidates.length;
    assert.equal(p.candidates, liveRows + p.handed_off);
    assert.equal(p.register_rate.of, p.candidates);
    assert.equal(p.register_rate.n, p.registered);
    assert.equal(p.decline_rate.n, p.declined);
    assert.ok(p.declined >= 1);
    const runsLog = (await query(`SELECT count(*)::int n FROM engine_writes WHERE endpoint IN ('page:draft_pattern','mcp:draft_pattern_candidate') AND outcome = 'read'`)).rows[0].n;
    assert.equal(p.drafts.runs, runsLog, 'every draft run counted, page and MCP');
    assert.ok(p.draft_to_register.n >= 2, 'the drafted-then-registered candidates count, though their rows are gone');
    const unreadRow = pg.candidates.find((c) => c.id === unread);
    assert.equal(unreadRow.draft_runs, 1, 'a draft never registered still counts on its candidate');
    assert.equal(typeof unreadRow.days_in_proposed, 'number');
    assert.ok(p.time_in_proposed.n >= 1 && p.time_in_proposed.p50 !== null && p.time_in_proposed.oldest !== null);
    assert.equal(pg.candidates.find((c) => c.id === cDec).days_in_proposed, null, 'a declined candidate is not in Proposed');
    assert.ok(p.notes.some((n) => /never a mean/.test(n)));
    // get_page_data reads the same figures, as a client would.
    const gpd = await mcp('get_page_data', { path: '/build-patterns', fields: ['pipeline.drafts.runs', 'pipeline.handed_off', 'pipeline.draft_to_register'] });
    const val = (k) => (gpd.fields || gpd.values || []).find((x) => x.path === k);
    const got = JSON.stringify(gpd);
    assert.ok(got.includes('/api/pattern-candidates'), got.slice(0, 800));
    assert.equal(val('pipeline.drafts.runs')?.value, p.drafts.runs, got.slice(0, 800));
    assert.equal(val('pipeline.handed_off')?.value, p.handed_off);
    step('pipeline: draft runs per candidate (both doors), time in Proposed, rates with denominators, handoffs counted after deletion, readable over get_page_data');

    /* ---- the audit ---- */
    const audit = (await query(`SELECT tool, kind, outcome, requester_user_id FROM engine_mcp_writes WHERE access = 'page' AND id > $1 ORDER BY id`, [auditFrom])).rows;
    const tools = audit.map((a) => `${a.tool}:${a.kind}:${a.outcome}`);
    assert.ok(tools.includes('update_record:pattern_candidates:updated'), tools.join(', '));
    assert.ok(tools.includes('create_record:patterns:inserted'), tools.join(', '));
    const pageLines = (await query(`SELECT endpoint, key_label FROM engine_writes WHERE natural_id = ANY($1) AND endpoint LIKE 'page:%'`, [[cReg, cDec, cRea, reg.body.pattern_id]])).rows;
    assert.ok(pageLines.some((l) => l.endpoint === 'page:create_record' && l.key_label === 'session cookie'), JSON.stringify(pageLines));
    assert.ok(pageLines.some((l) => l.endpoint === 'page:update_record'));
    step("audit: engine_mcp_writes access 'page', engine_writes page:<tool>");

    /* ---- the read connection never lists the page's access ---- */
    const list = await request('POST', `/mcp/${TOKEN}`, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { cookie: '' });
    assert.ok(list.body.result.tools.length > 10);
    step('MCP tools/list unaffected');
  } catch (e) {
    console.error(log.split('\n').slice(-30).join('\n'));
    throw e;
  } finally {
    // The throwaway announcement comes out of the channel, as Bays, the way it went in.
    for (const ts of [...posts.keys()]) {
      const r = await fetch(`http://127.0.0.1:${slackSrv.address().port}/api/chat.delete`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ channel: 'C0B0668PRNW', ts }) }).then((x) => x.json());
      assert.equal(r.ok, true, 'announcement deleted');
    }
    // The throwaway rows go through the same delete path the tools use.
    for (const n of made.patterns) await mcp('delete_record', { kind: 'patterns', natural_id: n, confirm: `DELETE ${n}`, reason: 'candidate test cleanup', requester_user_id: DESTINY });
    for (const n of made.candidates) await mcp('delete_record', { kind: 'pattern_candidates', natural_id: n, confirm: `DELETE ${n}`, reason: 'candidate test cleanup', requester_user_id: DESTINY });
    for (const n of made.profiles) await mcp('delete_record', { kind: 'builder_profiles', natural_id: n, confirm: `DELETE ${n}`, reason: 'candidate test cleanup', requester_user_id: DESTINY });
    const left = (await query(`SELECT (SELECT count(*) FROM engine_pattern_candidates WHERE natural_id = ANY($1)) + (SELECT count(*) FROM engine_build_patterns WHERE natural_id = ANY($2)) + (SELECT count(*) FROM engine_builder_profiles WHERE natural_id = ANY($3)) AS n`, [made.candidates, made.patterns, made.profiles])).rows[0].n;
    server.kill();
    google.close();
    slackSrv.close();
    openrouter.close();
    bharag.close();
    await query(`DELETE FROM engine_codex_submissions WHERE natural_id LIKE $1`, [`UTSUB_${T}`]).catch(() => {});
    await closePool();
    assert.equal(Number(left), 0, 'every throwaway row deleted');
  }
  console.log(`test:candidates — ${passed.length} steps held:\n  ${passed.join('\n  ')}\n  every throwaway row and channel post deleted`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
