/**
 * The Production-Income Board over MCP (20 Nov 2026, Destiny; Jason in #bha-coordination 1795202126.334919).
 * ../incomeBoard.ts holds the logic.
 *   read_income_board      read, both connections, every agent's scope: the Yes/No, every blocker by id with its
 *                          lane, owner and target date, the two gates, and the CST lane summary.
 *   set_income_board_item  write connection, Genie's scope: put a loop or watch on the board or take one off.
 *                          Destiny or Jason only (the requester is checked here), a reason required, audited.
 */
import * as board from '../incomeBoard';
import * as mirror from '../mirror';
import { auditClose, auditOpen } from './writeTools';
import type { ToolDefinition } from './tools';

export const readIncomeBoard: ToolDefinition = {
  name: 'read_income_board',
  description: `The Production-Income Board (${board.BOARD_KEY}), Jason's reference for what gets worked on and who gets paid. Answers "${board.QUESTION}: Yes or No", and when No, every blocker by its id (LOOP-, DW-, or one of two gates: a real Stage 1 record passed, and real buyers may be charged) with its status, lane, owner and target date, plus a CST lane summary (open loops, moving and stalled, open watches), and blocked_loops: every open loop marked blocked, with what blocks it, its unblock date (late when past), lane, tag, why and owner. Each item's state is read from its own loop or watch now. Quote ready and why as given, and link a blocker by its link. Read only.`,
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, title: 'Read the Production-Income Board' },
  handler: async (_args, deps) => {
    const t0 = Date.now();
    const [r, blocked] = await Promise.all([board.read(), board.blockers()]);
    await mirror
      .logWrite({ endpoint: 'mcp:read_income_board', kind: 'income_board', method: 'MCP', key_label: deps.access === 'write' ? 'MCP_WRITE_TOKEN' : 'MCP_SECRET', outcome: 'read', detail: `${r.ready} ${r.blocking.length} blocking`, ms: Date.now() - t0 })
      .catch(() => undefined);
    return { ok: true, ...r, blocked_loops: blocked };
  },
};

export const setIncomeBoardItem: ToolDefinition = {
  name: 'set_income_board_item',
  description: `Put a loop (LOOP-...) or Decision Watch (DW-...) on the Production-Income Board (${board.BOARD_KEY}) as something that blocks "${board.QUESTION}", or take one off. Only when Destiny (U0AEW3TBYH1) or Jason (U0A9V97949F) asks, in this conversation: pass them as requester_user_id; anyone else is refused. reason is required (what it blocks, or why it comes off); target_date (YYYY-MM-DD) is optional and only what the person said, never guessed. Nothing is deleted: a removal is dated and signed. dry_run checks and writes nothing. Audited on engine_mcp_writes (kind income_board).`,
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['add', 'remove'] },
      record_id: { type: 'string', description: 'LOOP-... or DW-...' },
      reason: { type: 'string' },
      target_date: { type: 'string', description: 'YYYY-MM-DD, only if the person gave one.' },
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
    const action = args.action === 'remove' ? 'remove' : args.action === 'add' ? 'add' : null;
    if (!action) {
      await auditClose(audit, { outcome: 'refused', detail: 'bad_action' });
      return { ok: false, reason: 'bad_action', message: 'action is add or remove.' };
    }
    try {
      const r = await board.setItem({ action, record_id: String(args.record_id ?? ''), reason: typeof args.reason === 'string' ? args.reason : null, target_date: typeof args.target_date === 'string' ? args.target_date : null, requester }, dry);
      await auditClose(audit, { outcome: r.ok ? (dry ? 'dry_run' : action === 'add' ? 'inserted' : 'applied') : 'refused', detail: String(r.ok ? (r.added ?? r.removed ?? r.would) : r.reason) });
      return { ...r, audit_id: audit };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      await auditClose(audit, { outcome: 'failed', detail: message });
      return { ok: false, reason: 'error', message, raise: true, audit_id: audit };
    }
  },
};

export const INCOME_BOARD_READ_TOOLS: ToolDefinition[] = [readIncomeBoard];
export const INCOME_BOARD_WRITE_TOOLS: ToolDefinition[] = [setIncomeBoardItem];
