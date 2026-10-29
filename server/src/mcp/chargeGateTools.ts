/**
 * The charge gate over MCP (2026-10-22, Destiny — Jason on the 22 Oct log). The rules and the
 * store are ../chargeGate.ts; these tools only carry a call to it.
 *
 *   `read_charge_gate`    — read. Can real buyers be charged on a rail now, why, and the history.
 *   `record_charge_gate`  — record Hardik's acceptance pass or Jason's live-offer approval.
 *                           Write connection, in no agent's scope, and refused on any agent token.
 *
 * Every write call is on engine_mcp_writes, kind charge_gate, refused ones included.
 */
import * as gate from '../chargeGate';
import * as mirror from '../mirror';
import { auditClose, auditOpen } from './writeTools';
import type { ToolDefinition } from './tools';

const str = (args: Record<string, unknown>, key: string): string => (typeof args[key] === 'string' ? (args[key] as string).trim() : '');

export const readChargeGate: ToolDefinition = {
  name: 'read_charge_gate',
  description:
    'Can real buyers be charged money right now? Answers from the engine\'s charge gate: Hardik\'s acceptance pass on the payment path (green or red) and Jason\'s approval of a live offer (approved or withdrawn), each recorded only from that person\'s own Slack message. can_charge_live is true only while the newest pass is green AND the newest offer is approved; anything else, or nothing recorded, is "no", and `answer` says why in words to quote. If this read fails, say you do not know; never say yes. Returns {rail, can_charge_live, answer, missing, acceptance_pass, offer_approval, history, rules}. Test rows never count and are listed only with include_test.',
  inputSchema: {
    type: 'object',
    properties: {
      rail: { type: 'string', enum: [...gate.RAILS], description: 'Default vfarm_stripe_live.' },
      include_test: { type: 'boolean', description: 'List test rows in history too. They never count.' },
      limit: { type: 'number', description: 'History rows, newest first. Default 20, at most 200.' },
    },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, title: 'Can we charge real buyers (charge gate)' },
  handler: async (args, deps) => {
    const t0 = Date.now();
    const rail = (str(args, 'rail') || 'vfarm_stripe_live') as gate.Rail;
    if (!gate.RAILS.includes(rail)) return { ok: false, reason: 'unknown_rail', message: `rail must be one of: ${gate.RAILS.join(', ')}.` };
    const s = await gate.status(rail);
    const history = await gate.history({ rail, include_test: args.include_test === true, limit: typeof args.limit === 'number' ? args.limit : 20 });
    await mirror.logWrite({ endpoint: 'mcp:read_charge_gate', kind: 'charge_gate', method: 'MCP', key_label: deps.access === 'write' ? 'MCP_WRITE_TOKEN' : 'MCP_SECRET', outcome: 'read', detail: `${rail} → can_charge_live ${s.can_charge_live}`, ms: Date.now() - t0 });
    return { ok: true, ...s, history, rules: gate.RULES };
  },
};

export const recordChargeGate: ToolDefinition = {
  name: 'record_charge_gate',
  description:
    `Record ONE charge-gate verdict: Hardik's acceptance_pass on the payment path (green or red) or Jason's offer_approval of a live offer (approved or withdrawn). These are the two records "can we charge real buyers" waits on. HELD HERE: decided_by must be the owner (acceptance_pass ${gate.HARDIK}, offer_approval ${gate.JASON}) (not_the_owner); requester_user_id is the owner or Destiny (not_permitted); evidence_link is the Slack link of the owner's own message saying it, and Slack must confirm that person posted it (evidence_required, evidence_not_found, evidence_unchecked, evidence_not_owners); an approved offer names what is approved in scope, in Jason's words (scope_required), and is Jason's offer_approved event: offer_id, loop_id and a conditions snapshot (offer_id_required, loop_id_required, conditions_required); a withdrawal names offer_id; a green pass names its acceptance bundle in bundle_ref, as the bundle's evidence store id EV-… (bundle_required; bundle_not_evidence, bundle_not_found or bundle_is_test when the record is not held here, unless the pass is a test). approver_id is decided_by and the timestamp is the row's own. An approval also writes one offer_approved (or offer_withdrawn) engine event with those fields. Never fill a verdict, scope or link in for anyone. Rows are never edited: a change of mind is a new row. One decision is one row: the same message, kind, verdict, rail and test flag recorded again returns the row already held (written false, duplicate true, same gate_id, no new event); the same message and verdict stating a different bundle_ref, offer_id, loop_id, conditions or scope is refused (decision_conflict, naming existing_gate_id). Refused on any agent token. dry_run checks everything, Slack included, and writes nothing. test: true marks a test row that never counts. Returns {ok, written, duplicate, row, status, message}. Audited on engine_mcp_writes.`,
  inputSchema: {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: [...gate.KINDS] },
      verdict: { type: 'string', description: 'acceptance_pass: green or red. offer_approval: approved or withdrawn.' },
      decided_by: { type: 'string', description: `The owner's Slack id: ${gate.HARDIK} for acceptance_pass, ${gate.JASON} for offer_approval.` },
      evidence_link: { type: 'string', description: "Slack link (Copy link) to the owner's own message giving this verdict." },
      scope: { type: 'string', description: 'For an approved offer: what is approved, in Jason\'s words. Required then.' },
      notes: { type: 'string' },
      offer_id: { type: 'string', description: 'offer_approval: the offer approved or withdrawn. Required on both.' },
      loop_id: { type: 'string', description: 'offer_approval, approved: the loop the offer belongs to (LOOP-<ms>-<4>). Required.' },
      conditions: { description: 'offer_approval, approved: the conditions snapshot as Jason set them (an object, or his words). Required; never filled in for him.' },
      bundle_ref: { type: 'string', description: "acceptance_pass, green: the evidence store id (EV-…) of the acceptance bundle the pass rests on. Save the bundle with save_evidence first; read_evidence finds its id. Required." },
      rail: { type: 'string', enum: [...gate.RAILS], description: 'Default vfarm_stripe_live.' },
      requester_user_id: { type: 'string', description: 'Slack id of the person recording this: the owner or Destiny.' },
      test: { type: 'boolean', description: 'true marks a TEST row that never counts.' },
      dry_run: { type: 'boolean', description: 'Check everything and write nothing.' },
    },
    required: ['kind', 'verdict', 'decided_by', 'evidence_link', 'requester_user_id'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true, title: 'Record a charge-gate verdict' },
  handler: async (args, deps) => {
    const requester = str(args, 'requester_user_id') || null;
    const dry = args.dry_run === true;
    const audit = await auditOpen({ tool: 'record_charge_gate', args, access: deps.access, kind: 'charge_gate', requester, dry_run: dry });
    if (deps.agent) {
      const message = `An agent (${deps.agent}) may not record a charge-gate verdict: it is Hardik's or Jason's, recorded by them or Destiny.`;
      await auditClose(audit, { outcome: 'refused', detail: `agent_not_permitted: ${message}`, guard_result: { reason: 'agent_not_permitted' } });
      return { ok: false, written: false, reason: 'agent_not_permitted', message: `${message} Nothing was recorded.`, audit_id: audit };
    }
    try {
      const r = await gate.recordGate(
        {
          kind: str(args, 'kind'),
          rail: str(args, 'rail') || null,
          verdict: str(args, 'verdict'),
          decided_by: str(args, 'decided_by'),
          evidence_link: str(args, 'evidence_link'),
          scope: str(args, 'scope') || null,
          notes: str(args, 'notes') || null,
          offer_id: str(args, 'offer_id') || null,
          loop_id: str(args, 'loop_id') || null,
          conditions: args.conditions ?? null,
          bundle_ref: str(args, 'bundle_ref') || null,
          recorded_by: requester ?? '',
          test: args.test === true,
        },
        { via: `mcp:${deps.access}`, dry_run: dry },
      );
      await auditClose(audit, { outcome: dry ? 'dry_run' : r.duplicate ? 'existing' : 'inserted', detail: r.message, natural_id: dry ? null : r.row.gate_id, after: r.row });
      return { ...r, audit_id: audit };
    } catch (e) {
      if (e instanceof gate.ChargeGateError) {
        await auditClose(audit, { outcome: 'refused', detail: `${e.reason}: ${e.message}`, guard_result: { reason: e.reason, ...e.extra } });
        return { ok: false, written: false, reason: e.reason, message: `${e.message} Nothing was recorded.`, ...e.extra, audit_id: audit };
      }
      const message = e instanceof Error ? e.message : String(e);
      await auditClose(audit, { outcome: 'failed', detail: message });
      return { ok: false, written: false, reason: 'error', message: `${message} Nothing was recorded.`, raise: true, audit_id: audit };
    }
  },
};

export const CHARGE_GATE_READ_TOOLS: ToolDefinition[] = [readChargeGate];
export const CHARGE_GATE_WRITE_TOOLS: ToolDefinition[] = [recordChargeGate];
