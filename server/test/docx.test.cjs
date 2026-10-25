/**
 * read_slack_file reading a Word file (2026-10-26, Destiny: "let's upgrade
 * Bays to be able to read docx and pdf when sent in chat").
 *
 * No database and no network: `pg.js` is replaced in the require cache, and
 * Slack's download and the read log are stood in on their modules. The Word
 * files are built here, in code, so nothing binary is committed. What is pinned:
 *
 *   - a .docx is read in order: paragraphs as lines, a tab as a tab, a line
 *     break as a new line, entities decoded, deleted (tracked) text left out;
 *   - a table row is one line with its cells joined by " | ", as in Hardik's
 *     acceptance bundle (two-column label | value tables);
 *   - a stored (uncompressed) entry reads the same as a deflated one;
 *   - through read_slack_file: type docx, ok, and the counts;
 *   - a spreadsheet zip and a plain zip are unsupported_type, named;
 *   - an image and an old .doc are unsupported_type, never bytes as text;
 *   - a damaged .docx is unreadable with the reason; an empty one no_text_layer;
 *   - plain text is still returned as text.
 *
 * Run with:  npm run test:docx
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const zlib = require('node:zlib');

const DIST = process.env.SERVER_DIST || path.join(__dirname, '../../server-dist');
let passed = 0;
const ok = (name) => (passed++, console.log(`  ok  ${name}`));

/* ---- the database, stood in before anything loads it ---- */
require.cache[require.resolve(path.join(DIST, 'server/src/pg.js'))] = {
  exports: { query: async () => ({ rows: [], rowCount: 0 }), withTransaction: async (fn) => fn({ query: async () => ({ rows: [], rowCount: 0 }) }), afterCommit: () => {} },
};

/* ---- a zip writer, enough for a .docx ---- */
function crc32(buf) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c >>> 0;
}
function zip(files, { store = false } = {}) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content);
    const comp = store ? data : zlib.deflateRawSync(data);
    const nameBuf = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(store ? 0 : 8, 8);
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, comp);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(store ? 0 : 8, 10);
    central.writeUInt32LE(crc32(data), 16);
    central.writeUInt32LE(comp.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const p = (...runs) => `<w:p><w:pPr><w:pStyle w:val="Normal"/></w:pPr>${runs.join('')}</w:p>`;
const r = (t) => `<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">${t}</w:t></w:r>`;
const cell = (...paras) => `<w:tc><w:tcPr><w:tcW w:w="2000"/></w:tcPr>${paras.join('')}</w:tc>`;
const BODY = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document ${W}><w:body>
${p(r('vFarm Stripe | Honest Gate Acceptance Bundle'))}
${p(r('STATUS: DRAFT &amp; NOT A PASS'), '<w:r><w:tab/></w:r>', r('&#8212; v1.0'))}
${p(r('Line one'), '<w:r><w:br/></w:r>', r('line two'))}
${p(r('Kept '), '<w:del w:id="1"><w:r><w:delText>removed </w:delText></w:r></w:del>', '<w:ins w:id="2">', r('inserted'), '</w:ins>')}
<w:p/>
<w:tbl><w:tblPr/>
<w:tr>${cell(p(r('Payment Intent')))}${cell(p(r('pi_3UT1MzGbAdOr3VUa17HLtjiK')))}</w:tr>
<w:tr>${cell(p(r('Amount')))}${cell(p(r('USD $1.00')), p(r('livemode true')))}</w:tr>
</w:tbl>
${p(r('After the table'), '<w:r><w:drawing><wp:inline/></w:drawing></w:r>')}
<w:sectPr/></w:body></w:document>`;
const DOCX = zip({ '[Content_Types].xml': '<Types/>', 'word/document.xml': BODY, 'word/styles.xml': '<w:styles/>' });
const EXPECTED = [
  'vFarm Stripe | Honest Gate Acceptance Bundle',
  'STATUS: DRAFT & NOT A PASS\t— v1.0',
  'Line one\nline two',
  'Kept inserted',
  '',
  'Payment Intent | pi_3UT1MzGbAdOr3VUa17HLtjiK',
  'Amount | USD $1.00 / livemode true',
  'After the table',
].join('\n');

(async () => {
  console.log('docx reader');
  const docx = require(path.join(DIST, 'server/src/docx.js'));

  const t = docx.extractDocxText(DOCX);
  assert.equal(t.text, EXPECTED);
  assert.equal(t.tables, 1);
  assert.equal(t.images, 1);
  ok('paragraphs, tab, break, entities, tracked deletions left out, table rows as "a | b", picture counted');

  assert.equal(docx.extractDocxText(zip({ 'word/document.xml': BODY }, { store: true })).text, EXPECTED);
  ok('a stored entry reads the same as a deflated one');

  assert.throws(() => docx.extractDocxText(Buffer.from('hello')), (e) => e.reason === 'not_a_zip');
  assert.throws(() => docx.extractDocxText(zip({ 'xl/workbook.xml': '<x/>' })), (e) => e.reason === 'not_a_docx');
  const cut = DOCX.subarray(0, 60);
  assert.throws(() => docx.extractDocxText(cut), (e) => e.reason === 'not_a_zip');
  ok('not a zip, a zip with no document, and a cut-short file each throw with their reason');

  /* ---- through the tool, with Slack and the read log stood in ---- */
  const slack = require(path.join(DIST, 'server/src/slack.js'));
  const mirror = require(path.join(DIST, 'server/src/mirror.js'));
  const logged = [];
  mirror.logWrite = async (line) => void logged.push(line);
  const FILES = {
    'bundle.docx': ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', DOCX],
    'sheet.xlsx': ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', zip({ '[Content_Types].xml': '<Types/>', 'xl/workbook.xml': '<x/>' })],
    'deck.pptx': ['application/vnd.openxmlformats-officedocument.presentationml.presentation', zip({ 'ppt/presentation.xml': '<p/>' })],
    'archive.zip': ['application/zip', zip({ 'a.txt': 'a' })],
    'photo.png': ['image/png', Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')],
    'old.doc': ['application/msword', Buffer.concat([Buffer.from('d0cf11e0a1b11ae1', 'hex'), Buffer.alloc(64)])],
    'broken.docx': ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', (() => {
      const b = Buffer.from(zip({ 'word/document.xml': BODY }));
      b.fill(0x41, 40, 120); // the deflated body overwritten
      return b;
    })()],
    'empty.docx': ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', zip({ 'word/document.xml': `<w:document ${W}><w:body><w:p/></w:body></w:document>` })],
    'notes.txt': ['text/plain; charset=utf-8', Buffer.from('Plain notes — café.\n')],
  };
  slack.slackConfigured = () => true;
  slack.download = async (url) => {
    const name = url.split('/').pop();
    const f = FILES[name];
    if (!f) return { ok: false, outcome: 'file_not_found', status: 404, message: 'not found' };
    return { ok: true, content_type: f[0], bytes: f[1] };
  };
  const { readSlackFile } = require(path.join(DIST, 'server/src/mcp/docTools.js'));
  const call = (name) => readSlackFile.handler({ url: `https://files.slack.com/files-pri/T1/F1/${name}` }, { access: 'read' });

  const d = await call('bundle.docx');
  assert.equal(d.ok, true);
  assert.equal(d.outcome, 'extracted');
  assert.equal(d.type, 'docx');
  assert.equal(d.text, EXPECTED);
  assert.equal(d.tables, 1);
  assert.equal(d.images_skipped, 1);
  assert.equal(d.truncated, false);
  ok('read_slack_file: a .docx comes back as its text, type docx, with the picture named as not read');

  for (const [name, word] of [['sheet.xlsx', 'Excel'], ['deck.pptx', 'PowerPoint'], ['archive.zip', 'zip archive']]) {
    const u = await call(name);
    assert.equal(u.ok, false, name);
    assert.equal(u.outcome, 'unsupported_type', name);
    assert.match(u.message, new RegExp(word), name);
    assert.equal(u.text, undefined, name);
  }
  ok('read_slack_file: a spreadsheet, a deck and a zip are unsupported_type, each named, no text');

  const png = await call('photo.png');
  assert.equal(png.outcome, 'unsupported_type');
  assert.equal(png.text, undefined);
  const doc = await call('old.doc');
  assert.equal(doc.outcome, 'unsupported_type');
  assert.match(doc.message, /old-format Office file/);
  ok('read_slack_file: an image and an old .doc are named, never handed back as bytes');

  const broken = await call('broken.docx');
  assert.equal(broken.ok, false);
  assert.equal(broken.outcome, 'unreadable');
  assert.match(broken.message, /could not be read/);
  const empty = await call('empty.docx');
  assert.equal(empty.outcome, 'no_text_layer');
  assert.equal(empty.type, 'docx');
  ok('read_slack_file: a damaged .docx is unreadable with the reason, an empty one no_text_layer');

  const txt = await call('notes.txt');
  assert.equal(txt.ok, true);
  assert.equal(txt.text, 'Plain notes — café.\n');
  ok('read_slack_file: plain text is still text');

  assert.equal(logged.length, 9, 'one read line per call');
  assert.ok(logged.every((l) => l.endpoint === 'mcp:read_slack_file' && l.outcome === 'read'));
  assert.ok(logged.some((l) => /bundle\.docx → extracted/.test(l.detail)));
  assert.ok(logged.some((l) => /sheet\.xlsx → unsupported_type/.test(l.detail)));
  ok('every read is logged, with its outcome');

  console.log(`\n${passed} passed`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
