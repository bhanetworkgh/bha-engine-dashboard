/**
 * The Airtable sweep's classifier (2026-09-24, LOOP-1790034076667-8HOF), pinned
 * on synthetic workflows: one per way a node can touch Airtable, and the
 * buckets each lands in. Pure — no server, no database, no n8n.
 *
 * Run with:  npm run test:airtable-sweep
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const s = require(path.join(__dirname, '../../server-dist/server/src/airtableSweep.js'));

const LOOPS = 'appUVlBSGGPHw6DGh';
const DESTINY_LOOPS = 'tblBJekl3ROpNZxQW';
const node = (name, type, parameters = {}, extra = {}) => ({ name, type, parameters, ...extra });
const cred = { airtableTokenApi: { id: 'IOwa36AoQylkenkh', name: 'Admin Airtable' } };

const live = {
  id: 'wfLIVE',
  name: 'Live',
  active: true,
  nodes: [
    node('Update Loop', 'n8n-nodes-base.airtable', { operation: 'update', base: { __rl: true, value: LOOPS }, table: { __rl: true, value: '={{ $json.t }}' } }, { credentials: cred }),
    node('Search Loop', 'n8n-nodes-base.airtable', { operation: 'search', base: { __rl: true, value: LOOPS }, table: { __rl: true, value: DESTINY_LOOPS } }, { credentials: cred }),
    node('Disabled Create', 'n8n-nodes-base.airtable', { operation: 'create', base: { __rl: true, value: 'appZZZZZZZZZZZZZZ' } }, { credentials: cred, disabled: true }),
    node('HTTP Patch', 'n8n-nodes-base.httpRequest', { method: 'PATCH', url: `https://api.airtable.com/v0/${LOOPS}/${DESTINY_LOOPS}` }),
    node('HTTP Get', 'n8n-nodes-base.httpRequest', { url: 'https://api.airtable.com/v0/appZZZZZZZZZZZZZZ/tblZZZZZZZZZZZZZZ' }),
    node('Code Cred', 'n8n-nodes-base.code', { jsCode: "await this.helpers.httpRequestWithAuthentication.call(this, 'airtableTokenApi', { method: 'POST', url: u })" }),
    node('Dashboard URL', 'n8n-nodes-base.httpRequest', { method: 'PATCH', url: `https://dash/api/engine/client_questions?table_id=tbl42Pl5mcYRNLYQV` }),
    node('Comment only', 'n8n-nodes-base.code', { jsCode: '// reshaped to the { id, fields } shape the Airtable node returned' }),
    node('Trigger', 'n8n-nodes-base.airtableTrigger', { baseId: { value: LOOPS } }, { credentials: cred }),
    node('Default op', 'n8n-nodes-base.airtable', { base: { __rl: true, value: LOOPS } }, { credentials: cred, typeVersion: 2.1 }),
    node('Sticky', 'n8n-nodes-base.stickyNote', { content: 'api.airtable.com' }),
    node('Unrelated', 'n8n-nodes-base.set', { values: {} }),
  ],
};
const off = { id: 'wfOFF', name: 'Off', active: false, nodes: [node('Old Write', 'n8n-nodes-base.airtableTool', { operation: 'upsert', base: { __rl: true, value: LOOPS } }, { credentials: cred })] };

const f = [...s.classifyWorkflow(live), ...s.classifyWorkflow(off)];
const by = (n) => f.find((x) => x.node === n);

assert.equal(by('Sticky'), undefined, 'sticky notes are not nodes');
assert.equal(by('Unrelated'), undefined);
assert.deepEqual([by('Update Loop').access, by('Update Loop').contact], ['write', 'call']);
assert.ok(by('Update Loop').owned_base_only.length, 'Open Loops base is owned whole');
assert.equal(by('Search Loop').access, 'read');
assert.ok(by('Search Loop').owned.some((o) => /Destiny/.test(o)), 'a loop table id is owned by id');
assert.equal(by('HTTP Patch').access, 'write');
assert.equal(by('HTTP Get').access, 'read', 'no method is n8n’s GET');
assert.deepEqual([by('Code Cred').contact, by('Code Cred').access], ['call', 'write'], 'a credential named in code is a call');
assert.deepEqual([by('Dashboard URL').contact, by('Dashboard URL').access], ['reference', 'none'], 'a dashboard URL carrying a tbl id is not an Airtable call');
assert.deepEqual([by('Comment only').contact, by('Comment only').access], ['reference', 'none']);
assert.equal(by('Trigger').access, 'trigger');
assert.equal(by('Default op').access, 'unknown', 'no operation set is unknown, never assumed read');

const r = s.report(f, { workflows: 2, workflows_active: 1, failed: [] });
const names = (xs) => xs.map((x) => x.node).sort();
assert.deepEqual(names(r.active_writers), ['Code Cred', 'Default op', 'HTTP Patch', 'Update Loop'], 'live writers, unknowns included');
assert.deepEqual(names(r.inactive_writers), ['Disabled Create', 'Old Write'], 'a disabled node and an inactive workflow would write if switched on');
assert.deepEqual(names(r.reads), ['HTTP Get', 'Search Loop', 'Trigger']);
assert.deepEqual(names(r.references), ['Comment only', 'Dashboard URL']);
assert.equal(r.credentials_in_use.length, 1);
assert.equal(r.credentials_in_use[0].workflows.length, 2);
console.log('test:airtable-sweep — classifier and buckets hold (22 assertions)');
