#!/usr/bin/env node
/**
 * Slim one n8n get_agent result for record_agent_inventory (10 Oct 2026).
 *
 * Bays' get_agent answer is past 160,000 characters, more than a tool call can
 * carry faithfully. This takes the long texts out by script and keeps every
 * field the inventory derives from: per tool its type, name, workflow, node
 * type, credentials, URL and approval flag; the MCP servers whole; the config's
 * own scalars; each skill's name, description and allowed tools; each task's
 * schedule. The instruction text is replaced by its length and sha256, counted
 * here from the real text. The server derives the same row from this as from
 * the whole result (test:agent-inventory).
 *
 *   node scripts/agent-inventory-slim.cjs <get_agent.json>  > slim.json
 */
const fs = require('node:fs');
const { createHash } = require('node:crypto');

function slim(result) {
  const config = result.config || {};
  const out = { ...config };
  const text = typeof config.instructions === 'string' ? config.instructions : null;
  delete out.instructions;
  if (text !== null) {
    out.instructions_chars = text.length;
    out.instructions_sha256 = createHash('sha256').update(text).digest('hex');
  }
  out.tools = (config.tools || []).map((t) => {
    const s = { type: t.type, name: t.name };
    for (const k of ['id', 'workflow', 'workflowId', 'requireApproval']) if (t[k] !== undefined) s[k] = t[k];
    if (t.node) {
      s.node = { nodeType: t.node.nodeType };
      if (t.node.credentials) s.node.credentials = t.node.credentials;
      const url = t.node.nodeParameters && t.node.nodeParameters.url;
      if (typeof url === 'string') s.node.nodeParameters = { url };
    }
    return s;
  });
  const skills = {};
  for (const [id, b] of Object.entries(result.skills || {})) skills[id] = { name: b.name, description: b.description, allowedTools: b.allowedTools };
  const tasks = (result.tasks || []).map((t) => ({ id: t.id, name: t.name, cronExpression: t.cronExpression, timezone: t.timezone, enabled: t.enabled }));
  return { agent: result.agent, config: out, configHash: result.configHash, skills, tasks };
}

module.exports = { slim };
if (require.main === module) {
  const file = process.argv[2];
  if (!file) {
    console.error('usage: node scripts/agent-inventory-slim.cjs <get_agent.json>');
    process.exit(1);
  }
  process.stdout.write(JSON.stringify(slim(JSON.parse(fs.readFileSync(file, 'utf8')))));
}
