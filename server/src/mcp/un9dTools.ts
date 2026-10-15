/**
 * check_un9d_acceptance (2026-10-15, Destiny — D3). Write connection only, in
 * no agent's scope: it records its result as one `un9d_acceptance_checked`
 * event, and changes nothing else. Runs Hardik's two UN9D tests against what
 * the dashboard holds for one farm (server/src/un9d.ts). Audited on
 * engine_mcp_writes, kind `vfarm`.
 */
import * as un9d from '../un9d';
import { auditClose, auditOpen } from './writeTools';
import type { ToolDefinition } from './tools';

export const checkUn9dAcceptanceTool: ToolDefinition = {
  name: 'check_un9d_acceptance',
  description:
    "Run Hardik's two UN9D acceptance tests against what the dashboard holds for one vFarm farm. Test 1 (canonical sensor-state read): every device has identity, placement, signal type, observed time; the received time is held; the evidence flag says real or simulated; stale data is never shown as live; the Monitoring Twin read and the stored feed agree. Test 2 (silent device to incident and back): a silent device opened an incident, it has one canonical ledger id, it recovered without a duplicate, and Engine health holds the same incident open or closed as the twin says. Every condition is pass, fail or not_yet_possible with the reason; a test passes only when every condition does. A simulated farm (SIM-TOMATO-01) can be checked and the answer says simulated: it proves the path, never the rack. record: false checks without writing the event. Changes no farm, device or incident.",
  inputSchema: {
    type: 'object',
    properties: {
      farm_id: { type: 'string', description: 'The farm id as vFarm sends it, e.g. SIM-TOMATO-01.' },
      record: { type: 'boolean', description: 'Write the result as an un9d_acceptance_checked event (default true).' },
    },
    required: ['farm_id'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false, title: 'Check UN9D acceptance' },
  handler: async (args, deps) => {
    const farmId = typeof args.farm_id === 'string' ? args.farm_id.trim() : '';
    const record = args.record !== false;
    const audit = await auditOpen({ tool: 'check_un9d_acceptance', args, access: deps.access, kind: 'vfarm', requester: null, dry_run: !record });
    try {
      if (!farmId) throw new un9d.CheckError(422, 'farm_id is required.');
      const r = await un9d.check(farmId, { record, actor: `mcp:${deps.access}` });
      await auditClose(audit, { outcome: record ? 'applied' : 'dry_run', detail: `${farmId}${r.simulated ? ' (simulated)' : ''}: ${r.verdict} (test 1 ${r.tests[0].verdict}, test 2 ${r.tests[1].verdict})`, natural_id: farmId, after: { verdict: r.verdict, event_id: r.event_id } });
      return { ok: true, ...r, audit_id: audit };
    } catch (e) {
      if (e instanceof un9d.CheckError) {
        await auditClose(audit, { outcome: 'refused', detail: e.message });
        return { ok: false, reason: e.status === 404 ? 'farm_not_held' : 'bad_request', message: e.message, audit_id: audit };
      }
      await auditClose(audit, { outcome: 'error', detail: e instanceof Error ? e.message : String(e) });
      throw e;
    }
  },
};

export const UN9D_WRITE_TOOLS: ToolDefinition[] = [checkUn9dAcceptanceTool];
