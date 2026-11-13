/**
 * `classify_outages` (13 Nov 2026, Destiny — Jason on 408M, 2 Nov): the rack's outage classification as
 * a read the Monitoring Twin, Genie and the agents call. Read only, both connections, in Genie's scope.
 * The rules are ../outageClass.ts and nowhere else; the client and SLA wording is
 * docs/contracts/outage-classification.md.
 */
import * as oc from '../outageClass';
import * as mirror from '../mirror';
import type { ToolDefinition } from './tools';

export const classifyOutages: ToolDefinition = {
  name: 'classify_outages',
  description: `Sorts the vFarm rack's sensor-path outages by cause and says which count against a run, by Jegan's 408M method. Each outage comes back with its start, end, duration, outage_type (${oc.OUTAGE_TYPES.join(', ')}) and counts_against_run. A gateway outage from before the Pi's boot record existed, or a board outage with no named cause, comes back outage_type null with both candidates and what would settle it: say it is unresolved, never pick one. Excluded from a run: power cuts the unit recovered from on its own, deploy reboots and clean reboots. Counted: gateway link drops, board hardware and valve coil, and anything unresolved. With no inputs it answers for the 408M reference dataset (Jegan's 2 Nov production read). Otherwise send board and pi stale windows, the boot record, boot_record_since and any annotations (a builder's log or the Pi journal naming a cause). This is what reliability wording about the rack rests on: never quote an uptime figure from it, and say which outages were excluded and why. Read only.`,
  inputSchema: {
    type: 'object',
    properties: {
      board: { type: 'array', description: 'Windows the UNO board was stale: [{start, end}] (ISO).', items: { type: 'object' } },
      pi: { type: 'array', description: "Windows the Pi's own health was stale: [{start, end}].", items: { type: 'object' } },
      boot: { type: 'array', description: "The Pi's boot record: [{at, cause: deploy|clean|power_loss, down_s, last_alive?}].", items: { type: 'object' } },
      boot_record_since: { type: 'string', description: 'When the boot record begins (ISO).' },
      annotations: { type: 'array', description: 'Causes named by a person or the Pi journal: [{start, end, outage_type, source}].', items: { type: 'object' } },
      from: { type: 'string' }, to: { type: 'string' },
      run: { type: 'object', description: 'The run being judged: {name, start}.' },
    },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, title: "Classify the rack's outages" },
  handler: async (args, deps) => {
    const t0 = Date.now();
    const a = (args ?? {}) as Partial<oc.ClassifyInput>;
    const reference = !a.board;
    if (!reference && (!Array.isArray(a.pi) || !Array.isArray(a.boot))) {
      return { ok: false, reason: 'bad_input', message: 'Send board, pi and boot together (empty arrays are fine), or none of them for the 408M reference dataset.' };
    }
    const input: oc.ClassifyInput = reference ? oc.REFERENCE_408M : { boot_record_since: null, annotations: [], ...a } as oc.ClassifyInput;
    const bad = (input.annotations ?? []).find((n) => !oc.OUTAGE_TYPES.includes(n.outage_type));
    if (bad) return { ok: false, reason: 'unknown_outage_type', message: `annotation outage_type must be one of ${oc.OUTAGE_TYPES.join(', ')}.` };
    const out = oc.classify(input);
    await mirror.logWrite({ endpoint: 'mcp:classify_outages', kind: 'vfarm', method: 'MCP', key_label: deps.access === 'write' ? 'MCP_WRITE_TOKEN' : 'MCP_SECRET', outcome: 'read', detail: `${reference ? '408M reference' : 'supplied data'}: ${out.summary.sensor_path_outages} sensor-path outages, ${out.summary.unresolved} unresolved`, ms: Date.now() - t0 });
    return { ok: true, dataset: reference ? '408M reference (Jegan, 2 Nov 2026, C0BT41XUWG7 1793617155.681509)' : 'supplied', rule: oc.RULE, ...out };
  },
};

export const OUTAGE_READ_TOOLS: ToolDefinition[] = [classifyOutages];
