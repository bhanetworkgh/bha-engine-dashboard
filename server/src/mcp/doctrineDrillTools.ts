/**
 * run_doctrine_drill (2026-10-20, Destiny — the QNDM drill Jason approved in the M4CV thread).
 *
 * One step of the SE8L watcher drill per call (doctrineDrill.ts): status, create, record_decision,
 * break, sweep, retire. A person's tool: write connection only, in no agent's scope, and only
 * Destiny or Jason (requester_user_id). Every step but status needs confirm "DRILL QNDM" and a
 * run id. It touches only the QNDM-DRILL doctrine; a sweep is the watcher's own sweep run once,
 * so it reads every claim in force and writes what the watcher would. Audited on
 * engine_mcp_writes (kind doctrine_drill), refused ones included.
 */
import * as drill from '../doctrineDrill';
import { ADMIN_IDS } from '../writeGuards';
import { auditClose, auditOpen } from './writeTools';
import type { ToolDefinition } from './tools';

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

export const runDoctrineDrillTool: ToolDefinition = {
  name: 'run_doctrine_drill',
  description:
    'Run one step of the QNDM drill for the SE8L doctrine-gap watcher, on the labelled drill doctrine QNDM-DRILL (claim BREAK, cleared for genie_ns only) and nothing else. step: status (where the drill stands: every row, decision and marker on the drill keys), create (log the drill doctrine), record_decision (the real decision for the drill claim on genie_ns, through the normal path; label names it, e.g. start or fix), break (one decision that contradicts the drill claim on purpose — the only write here no normal path allows), sweep (the watcher\'s own sweep run once by hand: every claim in force, the same writes and incident sync the timer would make; the timer stays off), retire (take the drill doctrine out of force). Every step but status needs run (the drill run id) and confirm exactly "DRILL QNDM". requester_user_id: Destiny or Jason. Audited on engine_mcp_writes.',
  inputSchema: {
    type: 'object',
    properties: {
      step: { type: 'string', enum: [...drill.STEPS] },
      run: { type: 'string', description: 'The drill run id, letters, digits or hyphens, e.g. 20261020.' },
      label: { type: 'string', description: 'record_decision only: which decision this is, e.g. start or fix.' },
      confirm: { type: 'string', description: 'Exactly "DRILL QNDM" for every step but status.' },
      requester_user_id: { type: 'string', description: 'Slack id of the person running it: Destiny or Jason.' },
    },
    required: ['step', 'requester_user_id'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true, title: 'Run one step of the QNDM doctrine drill' },
  handler: async (args, deps) => {
    const step = str(args.step) as drill.DrillStep;
    const run = str(args.run);
    const label = str(args.label).replace(/[^A-Za-z0-9-]/g, '').slice(0, 30);
    const requester = str(args.requester_user_id) || null;
    const audit = await auditOpen({ tool: 'run_doctrine_drill', args, access: deps.access, kind: 'doctrine_drill', requester, dry_run: false });
    const refuse = async (why: string, message: string) => {
      await auditClose(audit, { outcome: 'refused', detail: `${why}: ${message}`, guard_result: { reason: why } });
      return { ok: false, reason: why, message: `${message} Nothing was changed.`, audit_id: audit };
    };
    if (!requester || !ADMIN_IDS.includes(requester)) return refuse('not_permitted', 'Only Destiny or Jason can run the drill.');
    if (!drill.STEPS.includes(step)) return refuse('bad_step', `step must be one of ${drill.STEPS.join(', ')}.`);
    if (step !== 'status') {
      if (str(args.confirm) !== 'DRILL QNDM') return refuse('confirm_required', 'confirm must be exactly "DRILL QNDM".');
      if (!/^[A-Za-z0-9-]{1,40}$/.test(run)) return refuse('bad_run', 'run is required: 1 to 40 letters, digits or hyphens.');
      if (step === 'record_decision' && !label) return refuse('label_required', 'record_decision needs a label, e.g. start or fix.');
    }
    const actor = `engine:${requester} (QNDM drill ${run || 'status'})`;
    try {
      const result =
        step === 'status' ? await drill.status()
          : step === 'create' ? await drill.create(run, actor)
            : step === 'record_decision' ? await drill.recordDecision(run, label, actor)
              : step === 'break' ? await drill.breakIt(run, actor)
                : step === 'sweep' ? await drill.sweep()
                  : await drill.retire(run, actor);
      await auditClose(audit, { outcome: step === 'status' ? 'read' : 'applied', detail: `QNDM drill ${run || ''} ${step}`.trim(), natural_id: drill.DOCTRINE_ID, after: step === 'status' ? null : result });
      return { ok: true, step, run: run || null, result, audit_id: audit };
    } catch (e) {
      const reason = e instanceof drill.DrillError ? e.reason : 'failed';
      const message = e instanceof Error ? e.message : String(e);
      await auditClose(audit, { outcome: e instanceof drill.DrillError ? 'refused' : 'failed', detail: `${step}: ${message}`, guard_result: { reason } });
      return { ok: false, step, reason, message, raise: !(e instanceof drill.DrillError), audit_id: audit };
    }
  },
};

export const DOCTRINE_DRILL_WRITE_TOOLS: ToolDefinition[] = [runDoctrineDrillTool];
