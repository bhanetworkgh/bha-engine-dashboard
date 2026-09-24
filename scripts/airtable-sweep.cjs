#!/usr/bin/env node
/**
 * The hidden Airtable writer sweep (LOOP-1790034076667-8HOF), as a script.
 * The rules live in server/src/airtableSweep.ts; this only feeds it workflows.
 *
 *   npm run build:server
 *   N8N_API_KEY=… [N8N_API_URL=https://<host>/api/v1] node scripts/airtable-sweep.cjs
 *       reads every workflow through the n8n public API (GET only)
 *   node scripts/airtable-sweep.cjs --dir <folder of <id>.json workflow exports>
 *       reads workflow JSON from disk instead (e.g. exported through the n8n MCP)
 *
 *   --json <file>   also write the full report as JSON
 *
 * Prints a Markdown report: active writers first (the real risk), then writers
 * that would run if switched back on, then reads, then references. Changes
 * nothing anywhere. The same sweep runs on production as the MCP tool
 * sweep_airtable_nodes, with the server's own N8N_API_KEY.
 */
const fs = require('node:fs');
const path = require('node:path');

const dist = path.join(__dirname, '../server-dist/server/src');
if (!fs.existsSync(path.join(dist, 'airtableSweep.js'))) {
  console.error('Build first: npm run build:server');
  process.exit(1);
}
const sweep = require(path.join(dist, 'airtableSweep.js'));

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};

async function fromDir(dir) {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && !f.startsWith('_'));
  const byId = new Map(files.map((f) => [f.replace(/\.json$/, ''), path.join(dir, f)]));
  const index = fs.existsSync(path.join(dir, '_index.json')) ? JSON.parse(fs.readFileSync(path.join(dir, '_index.json'), 'utf8')) : null;
  const list = index ? index.map((w) => ({ id: String(w.id), name: String(w.name), active: w.active })) : [...byId.keys()].map((id) => ({ id, name: id }));
  return sweep.sweep(
    async () => list,
    async (id) => {
      const f = byId.get(id);
      if (!f) throw new Error('no JSON on disk for this workflow (it was listed but not exported)');
      return JSON.parse(fs.readFileSync(f, 'utf8'));
    },
  );
}

async function fromApi() {
  const n8n = require(path.join(dist, 'n8n.js'));
  if (!n8n.n8nConfigured()) {
    console.error(`${n8n.N8N_API_VAR} is not set. Set it (and N8N_API_URL if not the default), or pass --dir.`);
    process.exit(1);
  }
  return sweep.sweep(
    async () => {
      const l = await n8n.workflows(50);
      if (l.truncated) throw new Error('workflow listing hit its page ceiling');
      return l.workflows;
    },
    (id) => n8n.workflow(id),
  );
}

function table(rows) {
  if (!rows.length) return '_None._\n';
  const esc = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const lines = ['| workflow id | name | active | node | access | how decided | tables | dashboard owns it |', '|---|---|---|---|---|---|---|---|'];
  for (const f of rows) {
    const owned = [...f.owned, ...f.owned_base_only];
    lines.push(
      `| ${f.workflow_id} | ${esc(f.workflow_name)} | ${f.archived ? 'archived' : f.active ? 'yes' : 'no'} | ${esc(f.node)}${f.node_disabled ? ' (disabled)' : ''} | ${f.access} | ${esc(f.access_basis)} | ${esc([...f.tables, ...f.table_names, ...(f.tables.length || f.table_names.length ? [] : f.bases)].join(', ') || '—')} | ${owned.length ? esc(owned.join('; ')) : 'no'} |`,
    );
  }
  return lines.join('\n') + '\n';
}

(async () => {
  const dir = opt('--dir');
  const r = dir ? await fromDir(dir) : await fromApi();
  const out = [];
  out.push(`# Airtable sweep — ${r.swept_at}`);
  out.push('');
  out.push(`${r.workflows} workflows listed, ${r.workflows_active} active. ${r.workflows_read_failed.length} could not be read.`);
  for (const f of r.workflows_read_failed) out.push(`- NOT READ: ${f.id} ${f.name} — ${f.error}`);
  out.push('');
  out.push(`## Active writers — live, would run now (${r.active_writers.length})`);
  out.push(table(r.active_writers));
  out.push(`## Writers that would run if switched back on (${r.inactive_writers.length})`);
  out.push(table(r.inactive_writers));
  out.push(`## Reads (${r.reads.length})`);
  out.push(table(r.reads));
  out.push(`## References only — names an Airtable id or the word, no Airtable call (${r.references.length})`);
  out.push(table(r.references));
  out.push('## Airtable credentials named by nodes');
  if (!r.credentials_in_use.length) out.push('_None._');
  for (const c of r.credentials_in_use) out.push(`- ${c.name ?? '(no name)'} (${c.type}, id ${c.id ?? '?'}) — ${c.workflows.join('; ')}`);
  console.log(out.join('\n'));
  const j = opt('--json');
  if (j) fs.writeFileSync(j, JSON.stringify(r, null, 2));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
