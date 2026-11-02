// 2 Nov 2026 — the shorter tool descriptions served to agent tokens (agentDescriptions.ts).
// Every entry names a real tool, is shorter than the full one, and keeps the words an agent
// acts on for the tools where a rule lives only in prose.
const path = require('path');
const assert = require('assert');
const root = path.join(__dirname, '..', '..', 'server-dist', 'server', 'src', 'mcp');
const { AGENT_DESCRIPTIONS } = require(path.join(root, 'agentDescriptions.js'));
const { toolCatalogue } = require(path.join(root, 'tools.js'));
let n = 0;
const ok = (c, m) => { assert.ok(c, m); console.log(`ok ${++n} - ${m}`); };
const full = Object.fromEntries(toolCatalogue('write').map((t) => [t.name, t.description]));
let before = 0, after = 0;
for (const [name, short] of Object.entries(AGENT_DESCRIPTIONS)) {
  ok(full[name] !== undefined, `${name} is a real tool`);
  ok(short.length < full[name].length, `${name} is shorter (${short.length} < ${full[name].length})`);
  before += full[name].length; after += short.length;
}
const keeps = {
  close_decision_watch: ['proof', 'never a reason'],
  list_decision_watches: ['how_it_moves', 'as written'],
  open_decision_watch: ['never invent', 'numbered steps'],
  void_parked_log: ['confirmed: true', 'dry_run'],
  write_registry: ['Never guess a cost', 'Never put a password'],
  snooze_decision_watch: ['never pick one', 'Never cancel'],
  read_monitoring_twin: ['evidence_status', 'never the real rack'],
  send_nudge: ['awaiting_approval', 'do not retry'],
  read_buyer_flow: ['charge_gate', 'never a customer payment'],
};
for (const [name, words] of Object.entries(keeps)) for (const w of words) ok(AGENT_DESCRIPTIONS[name].includes(w), `${name} keeps "${w}"`);
console.log(`\n${n} checks passed; ${before} characters down to ${after}`);
