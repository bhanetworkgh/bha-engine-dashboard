/**
 * The evidence store (28 Oct 2026, D3). Part 1 checks the pure rules with no database. Part 2 runs
 * migration 103 against a LOCAL database (localhost or 127.0.0.1, name ending _test): a save from text
 * and from a Slack file (Slack stood in), every refusal, versions, the append-only trigger, the read tool,
 * and the charge gate refusing a green pass whose bundle is not in the store. It empties engine_evidence
 * at the end, so never point it at anything but a test database.
 * Run with:  npm run test:evidence   (after the server build; part 2 needs DATABASE_URL)
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const DIST = process.env.SERVER_DIST || path.join(__dirname, '../../server-dist');
const ev = require(path.join(DIST, 'server/src', 'evidence.js'));
let n = 0;
const ok = (m) => { n += 1; console.log('  ok  ' + m); };

const DESTINY = 'U0AEW3TBYH1';
const HARDIK = 'U0BKT6MAW2Y';
const STRANGER = 'U0STRANGER1';
const reason = async (p, r) => assert.rejects(p, (x) => { assert.equal(x.reason, r, `expected ${r}, got ${x.reason}: ${x.message}`); return true; });

(async () => {
  // ---------------------------------------------------------------- part 1, pure
  assert.equal(ev.normaliseName('Stripe_Acceptance_Bundle.docx'), 'stripe-acceptance-bundle');
  assert.equal(ev.normaliseName('Stripe Live 1USD Acceptance Evidence VFBUYER-FORMA-RU0W2P.md'), 'stripe-live-1usd-acceptance-evidence-vfbuyer-forma-ru0w2p');
  assert.equal(ev.normaliseName('  --Hello, World!--  '), 'hello-world');
  ok('a name is lower case and hyphens, with the file extension dropped');
  assert.ok(ev.EV_ID.test('EV-1793220000000-AB2C'));
  assert.ok(!ev.EV_ID.test('https://drive.google.com/x'));
  assert.ok(!ev.EV_ID.test('EV-123-ABCD'));
  ok('an evidence id is EV-<ms>-<4>');
  const bad = await ev.forGate('https://docs.google.com/document/d/x');
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'bundle_not_evidence');
  ok('a gate refuses a link that is not an evidence id, before any database read');

  const url = process.env.DATABASE_URL || '';
  if (!/@(localhost|127\.0\.0\.1)[:/]/.test(url) || !/_test(\?|$)/.test(url)) {
    console.log(`\n${n} checks passed (part 2 skipped: DATABASE_URL is not a local _test database)`);
    return;
  }
  const { migrate } = require(path.join(DIST, 'server/src', 'migrations.js'));
  const { query, closePool } = require(path.join(DIST, 'server/src', 'pg.js'));
  const gate = require(path.join(DIST, 'server/src', 'chargeGate.js'));
  await migrate();
  await query('TRUNCATE engine_evidence');
  await query(`INSERT INTO engine_builder_profiles (natural_id, fields, source, first_seen_at, updated_at) VALUES ($1, $2::jsonb, 'test', now()::text, now()::text) ON CONFLICT DO NOTHING`, [HARDIK, JSON.stringify({ user_id: HARDIK, name: 'Hardik Bhatt' })]).catch(() => undefined);
  try {
    // ------------------------------------------------------------ part 2, the database
    const E01 = '# E01: Stripe live $1 acceptance\n\nThe live $1 charge on 21 Oct paid and was refunded.\n\nPayment intent pi_TEST\n';
    const base = { proves: 'The live Stripe rail took a real $1 charge and the ledger recorded it.', gate: 'charge_gate', author_id: DESTINY, requester_user_id: DESTINY };

    const dry = await ev.save({ ...base, name: 'stripe-live-1usd-e01', text: E01, file_name: 'E01.md' }, { via: 'test', dry_run: true });
    assert.equal(dry.written, false);
    assert.equal((await query('SELECT count(*)::int AS c FROM engine_evidence')).rows[0].c, 0);
    ok('a dry run reads the document and writes nothing');

    const a = await ev.save({ ...base, name: 'stripe-live-1usd-e01', title: 'E01', text: E01, file_name: 'E01.md', written_at: '2026-10-23' }, { via: 'test' });
    assert.equal(a.written, true);
    assert.equal(a.record.version, 1);
    assert.equal(a.record.content_type, 'text/markdown');
    assert.equal(a.record.author_name, 'Destiny Arupi');
    assert.ok(ev.EV_ID.test(a.record.evidence_id));
    const got = await ev.get('stripe-live-1usd-e01');
    assert.equal(got.text, E01);
    assert.equal(got.evidence_id, a.record.evidence_id);
    const f = await ev.file(a.record.evidence_id);
    assert.equal(f.bytes.toString('utf8'), E01);
    ok('a text document is saved whole, readable by name or id, with its original file');
    const evt = await query(`SELECT count(*)::int AS c FROM engine_events WHERE event_type = 'evidence_saved' AND subject_id = $1`, [a.record.evidence_id]);
    assert.equal(evt.rows[0].c, 1);
    ok('a save writes one evidence_saved event');

    await reason(ev.save({ ...base, name: 'another-name', text: E01, file_name: 'E01.md' }, { via: 'test' }), 'already_saved');
    ok('the same file twice is refused, naming the record that holds it');
    await reason(ev.save({ ...base, name: 'stripe-live-1usd-e01', text: E01 + '\nfix', file_name: 'E01.md' }, { via: 'test' }), 'name_taken');
    ok('a name already held is refused unless the new version names the one it replaces');
    await reason(ev.save({ ...base, requester_user_id: STRANGER, name: 'x-doc', text: 'hello world text' }, { via: 'test' }), 'not_permitted');
    ok('only Destiny, Jason or someone with a Builder Profile may save');
    await reason(ev.save({ ...base, proves: 'short', name: 'x-doc', text: 'hello world text' }, { via: 'test' }), 'proves_required');
    ok('what a document proves must be written down');
    await reason(ev.save({ ...base, name: 'x-doc', text: 'hello', slack_file_id: 'F0ABCDEFG1' }, { via: 'test' }), 'one_source');
    ok('exactly one source: a Slack file or the text');

    const b = await ev.save({ ...base, name: 'stripe-live-1usd-e01', text: E01 + '\nCorrected.', file_name: 'E01.md', supersedes: a.record.evidence_id }, { via: 'test' });
    assert.equal(b.record.version, 2);
    await reason(ev.save({ ...base, name: 'stripe-live-1usd-e01', text: E01 + '\nAgain.', supersedes: a.record.evidence_id }, { via: 'test' }), 'supersedes_not_latest');
    const old = await ev.get(a.record.evidence_id);
    assert.equal(old.superseded_by, b.record.evidence_id);
    assert.equal((await ev.get('stripe-live-1usd-e01')).evidence_id, b.record.evidence_id);
    const listed = await ev.list();
    assert.equal(listed.records.filter((r) => r.name === 'stripe-live-1usd-e01').length, 1);
    assert.equal((await ev.list({ all_versions: true })).records.length, 2);
    ok('a correction is version 2; the old one stays readable and names its successor; the list shows the newest');

    await assert.rejects(query(`UPDATE engine_evidence SET proves = 'changed text here' WHERE evidence_id = $1`, [a.record.evidence_id]), /append-only/);
    await assert.rejects(query(`DELETE FROM engine_evidence WHERE evidence_id = $1`, [a.record.evidence_id]), /append-only/);
    ok('the table refuses every edit and every delete');

    // A Slack file, stood in: a Markdown file with Slack's octet-stream guess.
    const fetch = async ({ file_id }) => ({ bytes: Buffer.from('# Bundle\n\nHonest Gate checks passed.\n', 'utf8'), content_type: 'application/octet-stream', file_name: 'Stripe_Acceptance_Bundle.md', source_kind: 'slack_file', source_ref: `slack:${file_id}` });
    const c = await ev.save({ ...base, author_id: HARDIK, requester_user_id: HARDIK, slack_file_id: 'F0CBVG8CXUM', proves: 'Hardik\'s Honest Gate acceptance bundle for the Stripe path.' }, { via: 'test', fetch });
    assert.equal(c.record.name, 'stripe-acceptance-bundle');
    assert.equal(c.record.source_ref, 'slack:F0CBVG8CXUM');
    assert.equal(c.record.author_name, 'Hardik Bhatt');
    ok('a Slack file is saved under its own name, with who wrote it from their Builder Profile');
    const binary = async () => ({ bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]), content_type: 'image/png', file_name: 'x.png', source_kind: 'slack_file', source_ref: null });
    await reason(ev.save({ ...base, slack_file_id: 'F0ABCDEFG2', name: 'a-picture' }, { via: 'test', fetch: binary }), 'unsupported_type');
    ok('a file that is not text is refused, never stored as bytes read as text');

    // The read tool.
    const { readEvidence, saveEvidence } = require(path.join(DIST, 'server/src/mcp', 'evidenceTools.js'));
    const deps = { access: 'read', agent: null };
    const one = await readEvidence.handler({ name: 'stripe-acceptance-bundle' }, deps);
    assert.equal(one.ok, true);
    assert.ok(one.text.includes('Honest Gate'));
    assert.equal(one.text_truncated, false);
    const all = await readEvidence.handler({ gate: 'charge_gate' }, deps);
    assert.equal(all.total, 2);
    const none = await readEvidence.handler({ id: 'EV-1000000000000-ZZZZ' }, deps);
    assert.equal(none.ok, false);
    assert.equal(none.reason, 'not_found');
    const v1 = await readEvidence.handler({ name: 'stripe-live-1usd-e01', version: 1 }, deps);
    assert.equal(v1.evidence_id, a.record.evidence_id);
    ok('read_evidence finds a document by name, version, gate or id, and says when there is none');
    const tools = require(path.join(DIST, 'server/src/mcp', 'tools.js'));
    assert.ok(tools.toolByName('read_evidence', 'read'));
    assert.equal(tools.toolByName('save_evidence', 'read'), null);
    assert.ok(tools.toolByName('save_evidence', 'write'));
    ok('read_evidence is on both connections; save_evidence only on the write connection');
    const refusedTool = await saveEvidence.handler({ proves: 'x', author_id: DESTINY, requester_user_id: DESTINY, text: 'hello world text' }, { access: 'write', agent: null });
    assert.equal(refusedTool.ok, false);
    assert.equal(refusedTool.reason, 'proves_required');
    ok('save_evidence answers a refusal as ok: false with the reason, never a throw');

    // The charge gate.
    const LINK = 'https://bayshorizonnetwork.slack.com/archives/D0BKMFVU806/p1793205777233559';
    const author = async () => ({ ok: true, user: HARDIK });
    const pass = { kind: 'acceptance_pass', verdict: 'green', decided_by: HARDIK, evidence_link: LINK, recorded_by: DESTINY };
    const g1 = await gate.recordGate({ ...pass, bundle_ref: c.record.evidence_id }, { via: 'test', dry_run: true, checkMessage: author });
    assert.equal(g1.bundle.evidence_id, c.record.evidence_id);
    await reason(gate.recordGate({ ...pass, bundle_ref: 'https://drive.google.com/x' }, { via: 'test', dry_run: true, checkMessage: author }), 'bundle_not_evidence');
    await reason(gate.recordGate({ ...pass, bundle_ref: 'EV-1000000000000-ZZZZ' }, { via: 'test', dry_run: true, checkMessage: author }), 'bundle_not_found');
    const t = await ev.save({ ...base, name: 'test-bundle', text: 'TEST bundle text', test: true }, { via: 'test' });
    await reason(gate.recordGate({ ...pass, bundle_ref: t.record.evidence_id }, { via: 'test', dry_run: true, checkMessage: author }), 'bundle_is_test');
    const g2 = await gate.recordGate({ ...pass, bundle_ref: 'anything', test: true }, { via: 'test', dry_run: true, checkMessage: author });
    assert.equal(g2.bundle, null);
    ok('a real green pass rests on a held, non-test evidence record; a test pass may name anything');
    const g3 = await gate.recordGate({ ...pass, bundle_ref: a.record.evidence_id }, { via: 'test', dry_run: true, checkMessage: author });
    assert.equal(g3.bundle.superseded_by, b.record.evidence_id);
    ok('a pass on an older version is allowed and names the newer one');
  } finally {
    await query('TRUNCATE engine_evidence').catch(() => undefined);
    await query(`DELETE FROM engine_events WHERE event_type = 'evidence_saved'`).catch(() => undefined);
    await closePool();
  }
  console.log(`\n${n} checks passed`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
