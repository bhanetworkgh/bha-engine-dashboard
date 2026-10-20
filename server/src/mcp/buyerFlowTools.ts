/**
 * read_buyer_flow (18 Oct 2026, Destiny — the Engine Surfaces Contract,
 * docs/contracts/engine-surfaces-buyer-flow.md). Read only, both connections, in every
 * agent's scope and Genie's. Where each vFarm lead is in the five-stage flow and what Stripe
 * has seen for it, with no personal field, and the contract's never-infer rules beside it.
 * `leadFlow.read` selects no name, email, organisation or answer, so none can be returned.
 */
import * as mirror from '../mirror';
import * as leadFlow from '../leadFlow';
import { PIPELINE } from '../../../src/data/leadPipeline';
import type { ToolDefinition } from './tools';

const LIMIT = 50;
const LIMIT_MAX = 200;

export const readBuyerFlow: ToolDefinition = {
  name: 'read_buyer_flow',
  description:
    'Where each vFarm buyer lead is in the five-stage flow, and what Stripe has actually seen for it. The engine is the only place that decides either: show these values as written, and if this read fails say you do not know. Stages: 1 Interest (Form A), 2 Site specification (position "invited" until Form 2 is in, then "spec"), 3 Proposal, 4 Agreement and deposit, 5 Customer; "closed" with a reason wins over any stage. Payment state is paid, failed, expired or pending, and mode test or live: a test payment is never a customer payment. A payment sets no stage, entitlement or subscriber; every proposal is a test until Canon Lock; Stage 5 is not a subscriber. Without arguments: counts by position and payment over every lead, and the open leads newest first. Narrow with buyer_intake_id (one lead, closed or not) or position. No name, email, organisation or form answer is ever returned; the lead is named by its buyer_intake_id. Stage moves, closes and reopens are dated as vfarm_flow_stage_moved, vfarm_flow_closed and vfarm_flow_reopened in read_engine_events from 18 Oct 2026. The full contract is the SOP "SOP -- Engine Surfaces Contract: vFarm buyer flow and Stripe", read whole with read_sop.',
  inputSchema: {
    type: 'object',
    properties: {
      buyer_intake_id: { type: 'string', description: 'One lead, exactly, e.g. VFBUYER-FORMA-1A2B3C. Returned even if closed.' },
      position: { type: 'string', enum: PIPELINE.map((s) => s.key), description: 'Only leads at this position.' },
      include_closed: { type: 'boolean', description: 'Include closed leads in the list. Default false. Counts always include them.' },
      limit: { type: 'number', description: `How many leads to return. Default ${LIMIT}, at most ${LIMIT_MAX}.` },
    },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, title: 'vFarm buyer flow (stages and Stripe)' },
  handler: async (args, deps) => {
    const t0 = Date.now();
    const buyer = typeof args.buyer_intake_id === 'string' && args.buyer_intake_id.trim() ? args.buyer_intake_id.trim() : null;
    const position = typeof args.position === 'string' && args.position.trim() ? args.position.trim() : null;
    if (position && !PIPELINE.some((s) => s.key === position)) {
      return { ok: false, reason: 'unknown_position', message: `"${position}" is not a position. One of: ${PIPELINE.map((s) => s.key).join(', ')}.` };
    }
    const limit = Math.max(1, Math.min(LIMIT_MAX, Math.floor(Number(args.limit)) || LIMIT));
    const r = await leadFlow.read({ buyer_intake_id: buyer, position, include_closed: args.include_closed === true });
    const leads = r.leads.slice(0, limit);
    const out = {
      ok: true,
      contract: r.contract,
      asked_for: { buyer_intake_id: buyer, position, include_closed: args.include_closed === true },
      counts: r.counts,
      matched: r.leads.length,
      returned: leads.length,
      leads,
      rules: leadFlow.RULES,
      notes: [
        buyer && !r.leads.length ? `No lead carries buyer_intake_id ${buyer}. That is not proof the person never filled in Form A: check the id.` : null,
        r.leads.length > leads.length ? `${r.leads.length} leads matched and the newest ${leads.length} are returned. Narrow with position or raise limit (at most ${LIMIT_MAX}).` : null,
        'counts.payments is keyed state_mode, e.g. paid_test. A key that is not there means no such payment is recorded.',
      ].filter(Boolean),
    };
    await mirror.logWrite({ endpoint: 'mcp:read_buyer_flow', kind: 'vfarm_leads', method: 'MCP', key_label: deps.access === 'write' ? 'MCP_WRITE_TOKEN' : 'MCP_SECRET', outcome: 'read', detail: `${buyer ?? position ?? 'all'} → ${leads.length} of ${r.leads.length} (${r.counts.total} leads held)`, ms: Date.now() - t0 });
    return out;
  },
};

export const BUYER_FLOW_READ_TOOLS: ToolDefinition[] = [readBuyerFlow];
