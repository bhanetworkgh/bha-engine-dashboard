/**
 * BHA RSS reports what happens (16 Nov 2026, Destiny — Genie rebuild steps 4.2 and 4.3): the pure parts.
 * The posts themselves are proved live; this pins what is accepted, what each post says and when a
 * missing digest counts as missing.
 * Run with: npm run test:rss-reports
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const DIST = process.env.SERVER_DIST || path.join(__dirname, '../../server-dist');
const rr = require(path.join(DIST, 'server/src/rssReports'));
let n = 0;
const ok = (m) => { n += 1; console.log('  ok  ' + m); };

assert.throws(() => rr.parseError({ kind: 'bad', subject: 's', error: 'e' }), /kind must be one of/); ok('an unknown kind is refused');
assert.throws(() => rr.parseError({ kind: 'source_failed', error: 'e' }), /subject is required/); ok('a report with no subject is refused');
assert.throws(() => rr.parseError({ kind: 'source_failed', subject: 's' }), /error is required/); ok('a report with no error is refused');
const e = rr.parseError({ kind: 'source_failed', subject: 'src-1', error: 'answered 404 <script>', source_name: 'TechCrunch', source_url: 'https://techcrunch.com/feed' });
const m = rr.errorMessage(e);
assert.match(m.text, /^BHA RSS: a source could not be read/); ok('the post says what failed in plain words');
assert.ok(JSON.stringify(m.blocks).includes('&lt;script&gt;')); ok('what a service wrote is escaped before it is posted');
assert.ok(m.text.includes('(TechCrunch)')); ok('the source is named');
assert.ok(JSON.stringify(m.blocks).includes('https://techcrunch.com/feed')); ok('its address is on the card');
assert.equal(m.blocks[0].type, 'header'); ok('the error card opens with a header, in Bays\' style');
assert.ok(JSON.stringify(m.blocks).includes('<@U0AEW3TBYH1>')); ok('the error card tags Destiny');

assert.equal(rr.toSlack('See [the post](https://a.com/x?y=1&z=2) and **this**'), 'See <https://a.com/x?y=1&amp;z=2|the post> and *this*'); ok('Markdown links and bold become Slack format');
const body = '## What moved outside\n- One [a](https://a.com)\n- Two\n## Post ideas for the Media Twin\nNothing fits today.\n## Context for Genie\n- c';
assert.equal(rr.section(body, 'What moved outside'), '- One [a](https://a.com)\n- Two'); ok('the What moved outside section is read by its heading');
assert.equal(rr.section(body, 'Questions for Research Twin'), null); ok('a missing section reads as missing');
const d = rr.digestMessage({ digest_date: '2026-11-15', title: 'Outside digest -- 2026-11-15: x', body, items_used: 40, sources_used: 12 });
assert.equal(d.blocks[0].type, 'header'); ok('the digest card opens with a header');
assert.ok(d.blocks[0].text.text.includes('Sunday, 15 November 2026')); ok('the header names the day');
assert.ok(d.blocks[1].text.text.includes('<@U0AEW3TBYH1>') && d.blocks[1].text.text.includes('*x*')); ok('the card tags Destiny with the headline');
assert.ok(d.blocks[2].elements[0].text.includes('40 items read from 12 sources')); ok('the counts are on the card');
const all = JSON.stringify(d.blocks);
assert.ok(all.includes('*What moved outside*') && all.includes('• One <https://a.com|a>')); ok('What moved outside is on the card in Slack format');
assert.ok(all.includes('*Post ideas for the Media Twin*') && all.includes('*Context for Genie*')); ok('every section the digest has is on the card');
assert.ok(!all.includes('Questions for Research Twin')); ok('a section the digest lacks is left out');

assert.equal(rr.dueDate(new Date('2026-11-16T07:59:00Z')), null); ok('before 08:00 UTC no digest counts as missing');
assert.equal(rr.dueDate(new Date('2026-11-16T08:00:00Z')), '2026-11-15'); ok('from 08:00 UTC the day before is due');

console.log(`rss reports: ${n} checks passed`);
