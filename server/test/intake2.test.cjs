/**
 * Intake-2 (2026-10-14), against a local database with n8n, Google and Slack stood in.
 * Run with: npm run test:intake2
 */
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
if (!/@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL || '')) {
  console.error('test:intake2 writes rows, so it only runs against a local DATABASE_URL.');
  process.exit(1);
}
const DIST = process.env.SERVER_DIST || path.join(__dirname, '../../server-dist');

const st = { invites: [], failInvite: false, folders: [], uploads: [], posts: [] };
const srv = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks);
    const send = (code, o) => (res.writeHead(code, { 'content-type': 'application/json' }), res.end(JSON.stringify(o)));
    const url = req.url.split('?')[0];
    if (url === '/webhook/vfarm-intake2-invite') {
      const b = JSON.parse(raw.toString('utf8'));
      st.invites.push({ key: req.headers['x-dashboard-key'], ...b });
      if (st.failInvite) return send(500, { ok: false, error: 'Gmail refused: invalid_grant' });
      return send(200, { ok: true, gmail_message_id: `msg-${st.invites.length}` });
    }
    if (url === '/token') return send(200, { access_token: 'g-token', expires_in: 3600 });
    if (url === '/drive/v3/files') {
      const b = JSON.parse(raw.toString('utf8'));
      const id = `folder-${st.folders.length + 1}`;
      st.folders.push({ id, ...b });
      return send(200, { id, webViewLink: `https://drive.example/${id}` });
    }
    if (url === '/upload/drive/v3/files') {
      const text = raw.toString('latin1');
      const meta = JSON.parse(text.split('\r\n\r\n')[1].split('\r\n--')[0]);
      const id = `file-${st.uploads.length + 1}`;
      st.uploads.push({ id, ...meta, bytes: raw.length });
      return send(200, { id, name: meta.name, mimeType: 'application/pdf', size: '11', webViewLink: `https://drive.example/${id}` });
    }
    if (url === '/chat.postMessage') {
      const b = JSON.parse(raw.toString('utf8'));
      st.posts.push({ token: req.headers.authorization, ...b });
      return send(200, { ok: true, channel: b.channel, ts: `179200000${st.posts.length}.000100` });
    }
    send(404, { ok: false, error: 'unknown' });
  });
});

(async () => {
  const port = await new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
  const base = `http://127.0.0.1:${port}`;
  process.env.N8N_API_URL = `${base}/api/v1`;
  process.env.DASHBOARD_INBOUND_KEY = 'test-inbound-key';
  process.env.INTAKE2_LINK_SECRET = 'test-secret-intake2';
  process.env.PUBLIC_DASHBOARD_URL = 'https://dash.test';
  process.env.GOOGLE_API_URL = base;
  process.env.GOOGLE_OAUTH_CLIENT_ID = 'id';
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'secret';
  process.env.GOOGLE_OAUTH_REFRESH_TOKEN = 'refresh';
  process.env.SLACK_API_URL = base;
  process.env.SLACK_BAYS_BOT_TOKEN = 'xoxb-bays';
  const req = (m) => require(path.join(DIST, 'server/src', m));
  await req('migrations.js').migrate();
  const { query } = req('pg.js');
  const ea = req('earlyAccess.js');
  const i2 = req('intake2.js');
  const page = req('intake2Page.js');
  const { INTAKE2_FIELDS } = require(path.join(DIST, 'src/data/intake2.js'));

  let passed = 0;
  const ok = (n) => (passed++, console.log(`  ok  ${n}`));
  const T = Date.now().toString(36).toUpperCase();
  const BUYER = `VFBUYER-FORMA-T${T}`;
  await query(`DELETE FROM meta WHERE key = 'intake2.drive_parent'`);
  // Leftovers from an earlier failed run must not be swept here.
  await query(`DELETE FROM engine_vfarm_leads WHERE email LIKE '%@example.org' AND (form_a->>'buyer_intake_id' ~ '^VFBUYER-FORMA-[TU]' OR form_a IS NULL)`);
  const lead = async (o) =>
    (
      await query(
        `INSERT INTO engine_vfarm_leads (full_name, email, organization_name, source_surface, form_a) VALUES ($1, $2, $3, 'form_a', $4::jsonb) RETURNING id`,
        [o.name, o.email, o.org, o.form_a ? JSON.stringify(o.form_a) : null],
      )
    ).rows[0].id;
  const row = async (id) => (await query(`SELECT * FROM engine_vfarm_leads WHERE id = $1`, [id])).rows[0];
  const eventsFor = async (type, subject) => Number((await query(`SELECT count(*) FROM engine_events WHERE event_type = $1 AND subject_id = $2`, [type, subject])).rows[0].count);

  /* 0. the contract's numbers */
  assert.equal(INTAKE2_FIELDS.length, 31);
  assert.equal(INTAKE2_FIELDS.filter((f) => f.required).length, 25);
  assert.equal(INTAKE2_FIELDS.filter((f) => !f.required).length, 6);
  assert.deepEqual(INTAKE2_FIELDS.map((f) => f.n), Array.from({ length: 31 }, (_, i) => i + 1));
  ok('31 fields, 25 required, 6 optional, numbered in order');

  /* 1. a Stage 1 lead is refused, and nothing is sent */
  const L = await lead({ name: 'Ama Test Mensah', email: `ama+${T.toLowerCase()}@example.org`, org: 'Test Farm', form_a: { answers: {}, buyer_intake_id: BUYER, early_access_lead_id: `VFLEAD-${T}`, correlation_id: `VFARM-FORMA-T${T}`, source_campaign: null, submitted_at: null } });
  await assert.rejects(i2.issueInvite(L, { by: 'test' }), (e) => e.reason === 'not_stage_2' && e.status === 409);
  assert.equal(st.invites.length, 0);
  ok('a Stage 1 lead is refused; nothing sent');

  /* 2. the move to Stage 2 is the trigger */
  const moved = await ea.moveStage({ id: L }, 2, 'Jason (test)', 'serious buyer', 'page');
  assert.equal(moved.stage, 2);
  assert.equal(moved.intake_2_invite_result.ok, true);
  assert.equal(moved.intake_2_invite_result.reason, 'sent');
  assert.equal(st.invites.length, 1);
  const sent = st.invites[0];
  assert.equal(sent.key, 'test-inbound-key');
  assert.equal(sent.send_id, `VFINT2-SEND-FORMA-T${T}-1`);
  assert.equal(sent.invite_id, `VFINT2-INV-FORMA-T${T}`);
  assert.match(sent.link, /^https:\/\/dash\.test\/intake\/[A-Za-z0-9_-]{40,}$/);
  const token = sent.link.split('/').pop();
  let r = await row(L);
  assert.equal(r.intake_2_invite.token_sha256.length, 64);
  assert.ok(!JSON.stringify(r.intake_2_invite).includes(token), 'the token itself is never stored');
  assert.equal(r.intake_2_invite.sends[0].gmail_message_id, 'msg-1');
  assert.equal(await eventsFor('serious_buyer_spec_intake_invited', BUYER), 1);
  assert.equal(moved.intake_2_invite.token_sha256, undefined, 'the page never gets the hash');
  ok('Stage 1 to 2 makes the invite, emails it once, records one event, stores only the hash');

  /* 3. idempotent: asked again, nothing is sent; resend sends with the next id and the same link */
  const again = await i2.issueInvite(L, { by: 'test' });
  assert.equal(again.reason, 'already_sent');
  assert.equal(st.invites.length, 1);
  const re = await i2.issueInvite(L, { by: 'test', resend: true });
  assert.equal(re.reason, 'sent');
  assert.equal(st.invites[1].send_id, `VFINT2-SEND-FORMA-T${T}-2`);
  assert.equal(st.invites[1].link, sent.link);
  assert.equal(await eventsFor('serious_buyer_spec_intake_invited', BUYER), 1);
  ok('a repeat sends nothing; resend uses the next send id and the same link');

  /* 4. fails closed on identity */
  const OLD = await lead({ name: 'Old Route', email: `old+${T.toLowerCase()}@example.org`, org: null, form_a: null });
  await query(`UPDATE engine_vfarm_leads SET stage = 2 WHERE id = $1`, [OLD]);
  await assert.rejects(i2.issueInvite(OLD, { by: 'test' }), (e) => e.reason === 'no_buyer_intake_id');
  ok('a lead with no buyer intake id is refused');

  /* 5. the link opens this lead and no other, and says nothing private */
  assert.equal(await i2.isValid(token), true);
  assert.equal(await i2.isValid(token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A')), false);
  assert.equal(await i2.isValid('short'), false);
  const ps = await i2.pageState(token);
  assert.equal(ps.first_name, 'Ama');
  assert.equal(ps.submitted, false);
  assert.ok(!JSON.stringify(ps).includes('example.org'), 'no email on the page');
  r = await row(L);
  assert.ok(r.intake_2_invite.opened_at);
  ok('the link opens its own lead; a changed link opens nothing; the page gets no email');

  /* 6. uploads */
  await assert.rejects(i2.upload(token, 5, 'x.exe', 'application/x-msdownload', Buffer.from('MZ')), (e) => e.status === 415);
  await assert.rejects(i2.upload(token, 3, 'x.pdf', 'application/pdf', Buffer.from('%PDF-1.4')), (e) => e.reason === 'not_a_file_field');
  const f1 = await i2.upload(token, 5, 'site plan.pdf', 'application/pdf', Buffer.from('%PDF-1.4 hi'));
  const f2 = await i2.upload(token, 31, 'permit.pdf', 'application/pdf', Buffer.from('%PDF-1.4 hi'));
  assert.equal(st.folders.length, 2, 'one parent folder, one lead folder');
  assert.equal(st.uploads[1].parents[0], st.uploads[0].parents[0], 'both files in the lead folder');
  ok('only PDF, JPG, PNG on the two file questions; one private folder per lead');

  /* 7. validation */
  await assert.rejects(i2.submit(token, { answers: {} }, null), (e) => e.status === 422 && e.errors.length === 25);
  const good = {
    f1: 'Year-round tomatoes for the office cafe.',
    f2: { choice: 'Standard tomato P1.0 rack' },
    f3: '5',
    f4: { choice: 'Other', detail: '' },
    f5: [f1.file_id],
    f6: { p1: 'HQ', p2: '1 Main St', p3: 'Lagos', p4: 'Lagos', p5: 'Nigeria' },
    f7: { p1: '4', p2: '2.5', p3: '2.8', p4: 'm' },
    f8: { p1: '1', p2: 'Unknown', p3: '0.5', p4: '1', p5: 'm' },
    f9: { p1: 'Ground', p2: 'Sealed concrete', p3: 'Yes', p4: 'None known' },
    f10: { p1: '0.9', p2: '2.1', p3: 'm', p4: 'No', p5: 'Not applicable', p6: 'Loading dock' },
    f11: { p1: 'Available', p2: '230 V' },
    f12: { p1: 'Planned' },
    f13: { choice: 'Floor drain', detail: '3 m away' },
    f14: { p1: 'Fully indoor', p3: 'Yes' },
    f15: { p5: 'HVAC', p6: ['None known'] },
    f16: { choices: ['Facilities approval'] },
    f17: 'None known',
    f18: { choices: [] },
    f19: { choice: 'Buyer staff' },
    f20: { choice: 'Buyer staff' },
    f21: { choices: ['Remote status', 'Alerts'] },
    f22: { p1: '2026-12', p2: 'Target' },
    f23: { choice: 'Exploratory' },
    f24: 'Facilities lead, by email',
    f25: 'No blocker known',
    f26: { choice: 'Yes' },
    f30: { p1: 'Internal use' },
    f31: [f2.file_id],
  };
  await assert.rejects(i2.submit(token, { answers: good }, null), (e) => e.errors.length === 1 && e.errors[0].field === 4);
  good.f4 = { choice: 'Single row', detail: 'ignored' };
  await assert.rejects(i2.submit(token, { answers: { ...good, f5: ['not-uploaded-here'] } }, null), (e) => e.errors[0].field === 5);
  ok('25 required answers named when empty; "Other" needs its text; a file not uploaded on this link is refused');

  /* 8. submit: on the same row, one event, one Slack post, interest only */
  const before = Number((await query(`SELECT count(*) FROM engine_vfarm_leads`)).rows[0].count);
  const s1 = await i2.submit(token, { answers: good }, 'test-agent');
  assert.equal(s1.already, false);
  assert.equal(s1.submission_id, `VFINT2-SUB-FORMA-T${T}`);
  assert.equal(Number((await query(`SELECT count(*) FROM engine_vfarm_leads`)).rows[0].count), before, 'no new row');
  r = await row(L);
  assert.ok(r.intake_2_completed_at);
  const a = r.intake_2.answers;
  assert.equal(a['How many racks should the feasibility review evaluate?'], 5);
  assert.deepEqual(a['How do you expect the racks to be arranged?'], { choice: 'Single row' }, '"Other" text dropped when Other is not chosen');
  assert.equal(a['Confirm the proposed installation site.'].City, 'Lagos');
  assert.equal(a['Upload a site sketch or marked-up floor plan, if available.'][0].name, 'site plan.pdf');
  assert.equal(a['What network connectivity is available at the installation area?'], undefined, 'an optional field left empty is not stored');
  assert.equal(r.intake_2.buyer_intake_id, BUYER);
  assert.equal(await eventsFor('serious_buyer_spec_intake_completed', BUYER), 1);
  assert.equal(st.posts.length, 1);
  assert.equal(st.posts[0].channel, 'C0C36GPEB3L');
  assert.match(st.posts[0].text, /Interest only/);
  assert.equal(st.posts[0].token, 'Bearer xoxb-bays');
  assert.ok(r.intake_2.notified.ts);
  ok('answers land on the lead’s own row by label, one completion event, one Slack post as Bays');

  /* 9. a retry is a retry; a change is refused; nothing doubles */
  const s2 = await i2.submit(token, { answers: good }, null);
  assert.equal(s2.already, true);
  await assert.rejects(i2.submit(token, { answers: { ...good, f1: 'Something else' } }, null), (e) => e.status === 409);
  assert.equal(await eventsFor('serious_buyer_spec_intake_completed', BUYER), 1);
  assert.equal(st.posts.length, 1);
  await assert.rejects(i2.upload(token, 5, 'late.pdf', 'application/pdf', Buffer.from('%PDF')), (e) => e.status === 409);
  const after = await i2.issueInvite(L, { by: 'test', resend: true });
  assert.equal(after.reason, 'already_completed');
  assert.equal((await i2.pageState(token)).submitted, true);
  ok('same answers again are a retry; different answers are refused; no second event, post or email');

  /* 10. a send that fails is stored as failed, never as sent */
  const B2 = `VFBUYER-FORMA-U${T}`;
  const L2 = await lead({ name: 'Kofi Test', email: `kofi+${T.toLowerCase()}@example.org`, org: 'Other Farm', form_a: { answers: {}, buyer_intake_id: B2 } });
  st.failInvite = true;
  const m2 = await ea.moveStage({ id: L2 }, 2, 'test', null, 'engine');
  assert.equal(m2.stage, 2, 'the move stands');
  assert.equal(m2.intake_2_invite_result.reason, 'send_failed');
  assert.match(m2.intake_2_invite_result.message, /invalid_grant/);
  r = await row(L2);
  assert.equal(r.intake_2_invite.sends[0].outcome, 'failed');
  st.failInvite = false;
  const retry = await i2.issueInvite(L2, { by: 'test' });
  assert.equal(retry.reason, 'sent', 'a failed send is not an already-sent one');
  ok('a failed email is stored as failed with Gmail’s reason; the move stands; sending again works');

  /* 10b. the receipt went to the buyer on submit, once */
  const rcv = st.invites.filter((x) => x.kind === 'received');
  assert.equal(rcv.length, 1);
  assert.equal(rcv[0].send_id, `VFINT2-RCV-FORMA-T${T}`);
  assert.equal((await row(L)).intake_2.confirmation_email.outcome, 'sent');
  assert.equal(st.invites.filter((x) => x.kind === 'invite').length >= 2, true);
  ok('the buyer gets one receipt email on submit, recorded on the answers');

  /* 10c. stage 3 waits on Intake-2 */
  await assert.rejects(ea.moveStage({ id: L2 }, 3, 'test', null, 'page'), (e) => e.status === 409);
  const s3 = await ea.moveStage({ id: L }, 3, 'test', 'site spec in', 'page');
  assert.equal(s3.stage, 3);
  assert.equal(s3.intake_2_invite_result, undefined, 'stage 3 sends no invite');
  ok('Stage 3 is refused until Intake-2 is in, and moving there sends nothing');

  /* 10d. follow-ups at 3 and 7 days, unresponsive at 14, each step spaced, nothing doubled */
  const first = Date.parse((await row(L2)).intake_2_invite.sends.find((x) => x.outcome === 'sent').at);
  const at = (d) => new Date(first + d * 86400000 + 60000);
  const kinds = () => st.invites.filter((x) => x.send_id.includes(`U${T}`)).map((x) => x.kind);
  let sw = await i2.sweepFollowUps(at(2));
  assert.deepEqual(kinds().filter((k) => k !== 'invite'), []);
  sw = await i2.sweepFollowUps(at(3));
  assert.deepEqual(kinds().filter((k) => k !== 'invite'), ['followup_1']);
  await i2.sweepFollowUps(at(3.1));
  assert.deepEqual(kinds().filter((k) => k !== 'invite'), ['followup_1'], 'not sent twice');
  // A late start: at day 13 with fu2 not yet sent, fu2 goes, and unresponsive waits its own gap.
  await query(`UPDATE engine_vfarm_leads SET intake_2_invite = jsonb_set(intake_2_invite, '{followups,fu1,at}', to_jsonb($2::text)) WHERE id = $1`, [L2, at(3).toISOString()]);
  sw = await i2.sweepFollowUps(at(13));
  assert.deepEqual(kinds().filter((k) => k !== 'invite'), ['followup_1', 'followup_2']);
  assert.deepEqual(sw.unresponsive, []);
  // The send is stamped with the real clock; put it on the test's clock.
  await query(`UPDATE engine_vfarm_leads SET intake_2_invite = jsonb_set(intake_2_invite, '{followups,fu2,at}', to_jsonb($2::text)) WHERE id = $1`, [L2, at(13).toISOString()]);
  sw = await i2.sweepFollowUps(at(14));
  assert.deepEqual(sw.unresponsive, [], 'unresponsive waits 7 days after follow-up 2');
  sw = await i2.sweepFollowUps(at(20.1));
  assert.deepEqual(sw.unresponsive, [B2]);
  assert.ok((await row(L2)).intake_2_invite.unresponsive_at);
  assert.equal(await eventsFor('serious_buyer_spec_intake_unresponsive', B2), 1);
  assert.match(st.posts[st.posts.length - 1].text, /no answer after 14 days/);
  sw = await i2.sweepFollowUps(at(21));
  assert.deepEqual(sw.unresponsive, []);
  const cleared = await i2.clearUnresponsive(L2, 'test');
  assert.equal(cleared.ok, true);
  assert.equal((await row(L2)).intake_2_invite.unresponsive_at, undefined);
  await assert.rejects(i2.clearUnresponsive(L2, 'test'), (e) => e.status === 409);
  ok('follow-ups at 3 and 7 days, spaced on a late start, Unresponsive at 14 with one event and one post, clearable');

  /* 11. the buyer page's script parses, and carries no lead data */
  const html = page.formPage();
  const script = html.split('<script>')[1].split('</script>')[0];
  new Function(script);
  assert.ok(!html.includes('example.org'));
  assert.match(page.notValidPage(), /not valid/);
  ok('the page script parses; the page holds no lead data');

  // Tidy the rows this run wrote.
  await query(`DELETE FROM engine_events WHERE subject_id IN ($1, $2)`, [BUYER, B2]);
  await query(`DELETE FROM engine_vfarm_leads WHERE id IN ($1, $2, $3)`, [L, L2, OLD]);
  console.log(`\nintake-2: ${passed} of ${passed} passed`);
  srv.close();
  await req('pg.js').closePool();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
