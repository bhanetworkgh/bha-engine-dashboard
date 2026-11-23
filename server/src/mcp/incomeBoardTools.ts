/**
 * The Production-Income Board over MCP (20 Nov 2026, Destiny; Jason in #bha-coordination 1795202126.334919).
 * ../incomeBoard.ts holds the logic.
 *   read_income_board      read, both connections, every agent's scope: the Yes/No, every blocker by id with its
 *                          lane, owner and target date, the two gates, and the CST lane summary.
 *   set_income_board_item  write connection, Genie's scope: put a loop or watch on the board or take one off.
 *                          Destiny or Jason only (the requester is checked here), a reason required, audited.
 */
import * as board from '../incomeBoard';
import * as knowledge from '../knowledgeCapture';
import * as mirror from '../mirror';
import { auditClose, auditOpen } from './writeTools';
import type { ToolDefinition } from './tools';

export const readIncomeBoard: ToolDefinition = {
  name: 'read_income_board',
  description: `The Production-Income Board (${board.BOARD_KEY}), Jason's reference for what gets worked on and who gets paid. Answers "${board.QUESTION}: Yes or No", and when No, every blocker by its id (LOOP-, DW-, or one of two gates: a real Stage 1 record passed, and real buyers may be charged) with its status, lane, owner and target date, fields (Ready_for_first_paid_pilot, STAGE1_PASSED, CHARGE_GATE_OPEN, read from the records only, never set by hand), sections (Jason's seven, each with the item ids done and remaining), owner_views (what Ahad, Jegan, Kavin, Hardik and Destiny, and Jason each owe that blocks Pilot 1, soonest first), this_week (items moved, dates slipped, stalled CST loops), each item with its section, impact (BLOCKS_PILOT_1 or QUALITY_OF_LIFE), target_date and date_state (set, date_to_set, slipped with days_slipped, closed), plus a CST lane summary (open loops, moving and stalled, open watches), and blocked_loops: every open loop marked blocked, with what blocks it, its unblock date (late when past), lane, tag, why and owner. Each item's state is read from its own loop or watch now. blocked_loops is short by default (the counts, then the 25 that matter most: late first, then those that stop the paid pilot); full: true returns every one. knowledge_capture is every piece of knowledge only one person holds that the pilot needs written down: holder, area, where it lives, mark (BLOCKS_PILOT_1 or KNOWLEDGE_CAPTURE_REQUIRED), who picks it up, handover date, status and proof; a row with to_confirm set was drafted from the records and not yet confirmed by its holder, so say so. Quote ready and why as given, and link a blocker by its link. Read only.`,
  inputSchema: { type: 'object', properties: { full: { type: 'boolean', description: 'Every blocked loop, not the short list. Large.' } }, additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, title: 'Read the Production-Income Board' },
  handler: async (args, deps) => {
    const t0 = Date.now();
    const [r, all, kc] = await Promise.all([board.read(), board.blockers(), knowledge.read()]);
    const blocked = args.full === true ? all : board.shortBlockers(all);
    await mirror
      .logWrite({ endpoint: 'mcp:read_income_board', kind: 'income_board', method: 'MCP', key_label: deps.access === 'write' ? 'MCP_WRITE_TOKEN' : 'MCP_SECRET', outcome: 'read', detail: `${r.ready} ${r.blocking.length} blocking`, ms: Date.now() - t0 })
      .catch(() => undefined);
    return { ok: true, ...r, blocked_loops: blocked, knowledge_capture: kc };
  },
};

export const setIncomeBoardItem: ToolDefinition = {
  name: 'set_income_board_item',
  description: `Put a loop (LOOP-...) or Decision Watch (DW-...) on the Production-Income Board (${board.BOARD_KEY}) as something that blocks "${board.QUESTION}", change one already on it, or take one off. Each item sits in one of Jason's seven sections (${board.SECTION_KEYS.join(', ')}) and is BLOCKS_PILOT_1 or QUALITY_OF_LIFE; update changes only the section, impact or target_date sent (an empty target_date means date_to_set). Only when Destiny (U0AEW3TBYH1) or Jason (U0A9V97949F) asks, in this conversation: pass them as requester_user_id; anyone else is refused. reason is required (what it blocks, or why it comes off); target_date (YYYY-MM-DD) is optional and only what the person said, never guessed. Nothing is deleted: a removal is dated and signed. dry_run checks and writes nothing. Audited on engine_mcp_writes (kind income_board).`,
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['add', 'update', 'remove'] },
      record_id: { type: 'string', description: 'LOOP-... or DW-...' },
      reason: { type: 'string' },
      target_date: { type: 'string', description: 'YYYY-MM-DD, only if the person gave one; empty on update clears it to date_to_set.' },
      section: { type: 'string', enum: [...board.SECTION_KEYS] },
      impact: { type: 'string', enum: [...board.IMPACTS] },
      requester_user_id: { type: 'string' },
      channel_id: { type: 'string' },
      thread_ts: { type: 'string' },
      dry_run: { type: 'boolean' },
    },
    required: ['action', 'record_id', 'reason', 'requester_user_id'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false, title: 'Change the Production-Income Board' },
  handler: async (args, deps) => {
    const dry = args.dry_run === true;
    const requester = typeof args.requester_user_id === 'string' ? args.requester_user_id.trim() : null;
    const audit = await auditOpen({ tool: 'set_income_board_item', args, access: deps.access, kind: 'income_board', requester, dry_run: dry });
    const action = args.action === 'remove' ? 'remove' : args.action === 'add' ? 'add' : args.action === 'update' ? 'update' : null;
    if (!action) {
      await auditClose(audit, { outcome: 'refused', detail: 'bad_action' });
      return { ok: false, reason: 'bad_action', message: 'action is add, update or remove.' };
    }
    const opt = (k: string) => (k in args ? (typeof args[k] === 'string' ? (args[k] as string) : null) : undefined);
    try {
      const r = await board.setItem({ action, record_id: String(args.record_id ?? ''), reason: typeof args.reason === 'string' ? args.reason : null, target_date: opt('target_date'), section: opt('section'), impact: opt('impact'), requester }, dry);
      await auditClose(audit, { outcome: r.ok ? (dry ? 'dry_run' : action === 'add' ? 'inserted' : 'applied') : 'refused', detail: String(r.ok ? (r.added ?? r.updated ?? r.removed ?? r.would) : r.reason) });
      return { ...r, audit_id: audit };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      await auditClose(audit, { outcome: 'failed', detail: message });
      return { ok: false, reason: 'error', message, raise: true, audit_id: audit };
    }
  },
};


export const setKnowledgeCapture: ToolDefinition = {
  name: 'set_knowledge_capture',
  description: `Create, update or take off one knowledge capture row on the Production-Income Board: a piece of knowledge only one person holds that the paid pilot needs written down. Destiny (U0AEW3TBYH1) or Jason (U0A9V97949F) only, as requester_user_id. Without item_id it creates a row (holder, area, piece, mark required); with item_id it changes only the fields sent. holder and picked_up_by are Slack ids. mark is BLOCKS_PILOT_1 or KNOWLEDGE_CAPTURE_REQUIRED. lives_in is a list of {kind: repo|file|codex|watch|loop|doc|sop|evidence|service|other, ref, url?}. status is not_started, in_progress or captured; captured needs proof_ref (an EV- document held and not a test, a BHARAG SOP id, or an https link). to_confirm names who must confirm a drafted row. remove: true with a reason takes a row off (kept, dated and signed). dry_run writes nothing. Audited on engine_mcp_writes (kind income_board).`,
  inputSchema: {
    type: 'object',
    properties: {
      item_id: { type: 'string' },
      holder: { type: 'string' },
      area: { type: 'string' },
      piece: { type: 'string' },
      lives_in: { type: 'array', items: { type: 'object', properties: { kind: { type: 'string' }, ref: { type: 'string' }, url: { type: 'string' } }, required: ['kind', 'ref'] } },
      mark: { type: 'string', enum: [...knowledge.MARKS] },
      picked_up_by: { type: 'string' },
      handover_date: { type: 'string', description: 'YYYY-MM-DD' },
      status: { type: 'string', enum: [...knowledge.STATUSES] },
      proof_ref: { type: 'string' },
      to_confirm: { type: 'string' },
      notes: { type: 'string' },
      remove: { type: 'boolean' },
      reason: { type: 'string' },
      requester_user_id: { type: 'string' },
      dry_run: { type: 'boolean' },
    },
    required: ['requester_user_id'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false, title: 'Change a knowledge capture row' },
  handler: async (args, deps) => {
    const dry = args.dry_run === true;
    const requester = typeof args.requester_user_id === 'string' ? args.requester_user_id.trim() : null;
    const audit = await auditOpen({ tool: 'set_knowledge_capture', args, access: deps.access, kind: 'income_board', requester, dry_run: dry });
    try {
      const r = await knowledge.setItem(args as knowledge.KnowledgeInput, requester, dry);
      await auditClose(audit, { outcome: dry ? 'dry_run' : r.created ? 'inserted' : 'applied', detail: String(r.item_id ?? r.removed ?? r.would) });
      return { ...r, audit_id: audit };
    } catch (e) {
      if (e instanceof knowledge.KnowledgeError) {
        await auditClose(audit, { outcome: 'refused', detail: e.reason });
        return { ok: false, reason: e.reason, message: e.message, audit_id: audit };
      }
      const message = e instanceof Error ? e.message : String(e);
      await auditClose(audit, { outcome: 'failed', detail: message });
      return { ok: false, reason: 'error', message, raise: true, audit_id: audit };
    }
  },
};

export const INCOME_BOARD_READ_TOOLS: ToolDefinition[] = [readIncomeBoard];
export const INCOME_BOARD_WRITE_TOOLS: ToolDefinition[] = [setIncomeBoardItem, setKnowledgeCapture];
