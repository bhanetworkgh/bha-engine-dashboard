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

/**
 * The agent's shape of the board (26 Nov 2026, Destiny: the whole answer was about 101,000 characters and Genie reads
 * at 40,000, so it was cut partway and read as broken). Every id, owner, status and date is kept; long titles and
 * texts are shortened, items already listed under blocking are not repeated, and knowledge capture is its counts and
 * one short line per row. detail: true returns the page's shape whole. Pure.
 */
const clip = (v: unknown, n: number) => (typeof v === 'string' && v.length > n ? `${v.slice(0, n)}…` : v);
export function compactForAgent(r: Record<string, any>, blocked: Record<string, any>, kc: Record<string, any>) {
  const slim = (x: any) => ({ kind: x.kind, id: x.id, title: clip(x.title, 110), status: x.status, lane: x.lane, owner: x.owner, target_date: x.target_date, date_state: x.date_state, days_slipped: x.days_slipped, section: x.section, ...(x.kind === 'gate' ? { reason: clip(x.reason, 240) } : {}), link: x.link });
  const inBlocking = new Set((r.blocking ?? []).map((x: any) => x.id));
  const tw = r.this_week ?? {};
  const twRow = (x: any) => (x && typeof x === 'object' ? { ...x, title: clip(x.title, 70), what: clip(x.what, 70) } : x);
  const twList = (v: unknown) => (Array.isArray(v) ? v.map(twRow) : v);
  return {
    ...r,
    blocking: (r.blocking ?? []).map(slim),
    gates: (r.gates ?? []).map(slim),
    items: (r.items ?? []).filter((x: any) => !inBlocking.has(x.id)).map(slim),
    items_note: 'Items not repeated here are under blocking.',
    this_week: { ...tw, moved: twList(tw.moved), slipped: twList(tw.slipped), date_to_set: twList(tw.date_to_set), stalled_cst_loops: twList(tw.stalled_cst_loops) },
    cst: { ...(r.cst ?? {}), stalled_loops: ((r.cst ?? {}).stalled_loops ?? []).map((x: any) => ({ ...x, what: clip(x.what, 90) })) },
    blocked_loops: { ...blocked, rows: (blocked.rows ?? []).map((x: any) => ({ loop_id: x.loop_id, title: clip(x.title, 70), status: x.status, owner: x.owner, blocked_by: clip(x.blocked_by, 90), unblock_date: x.unblock_date, late: x.late, ...(x.late ? { days_late: x.days_late } : {}), why: clip(x.why, 70) })), link_rule: 'Each loop opens at https://dashboard.bhanetwork.org/open-loops/<loop_id>.' },
    knowledge_capture: {
      total: kc.total, blocks_pilot: kc.blocks_pilot, captured: kc.captured, no_pickup: kc.no_pickup, no_date: kc.no_date, late: kc.late, to_confirm: kc.to_confirm, by_holder: kc.by_holder, by_status: kc.by_status,
      rows: (kc.rows ?? []).map((x: any) => ({ item_id: x.item_id, holder: x.holder_name, area: x.area, piece: clip(x.piece, 70), mark: x.mark, status: x.status, picked_up_by: x.picked_up_by_name ?? x.picked_up_by ?? null, handover_date: x.handover_date, to_confirm: !!x.to_confirm })),
      note: 'Each row shortened; pass detail: true for where each piece lives and its proof.',
    },
    shape: 'Compact for agents: every id, owner, status and date is here, long texts are shortened. This is the whole board, not a cut read. detail: true returns every field.',
  };
}

export const readIncomeBoard: ToolDefinition = {
  name: 'read_income_board',
  description: `The Production-Income Board (${board.BOARD_KEY}), Jason's reference for what gets worked on and who gets paid. Answers "${board.QUESTION}: Yes or No", and when No, every blocker by its id (LOOP-, DW-, or one of two gates: a real Stage 1 record passed, and real buyers may be charged) with its status, lane, owner and target date, fields (Ready_for_first_paid_pilot, STAGE1_PASSED, CHARGE_GATE_OPEN, read from the records only, never set by hand), sections (Jason's seven, each with the item ids done and remaining), owner_views (what Ahad, Jegan, Kavin, Hardik and Destiny, and Jason each owe that blocks Pilot 1, soonest first), this_week (items moved, dates slipped, stalled CST loops), each item with its section, impact (BLOCKS_PILOT_1 or QUALITY_OF_LIFE), target_date and date_state (set, date_to_set, slipped with days_slipped, closed), plus a CST lane summary (open loops, moving and stalled, open watches), and blocked_loops: every open loop marked blocked, with what blocks it, its unblock date (late when past), lane, tag, why and owner. Each item's state is read from its own loop or watch now. blocked_loops is a summary by design (the counts over every blocked loop, then the 25 that matter most: late first, then those that stop the paid pilot): say how many of how many are shown, never that the read was cut; the evening report and the blocker tags are built from the full list on the dashboard, not from this read. blocked_owner (a name or Slack id) returns that person's blocked loops in full; full: true returns every one. knowledge_capture is every piece of knowledge only one person holds that the pilot needs written down: holder, area, where it lives, mark (BLOCKS_PILOT_1 or KNOWLEDGE_CAPTURE_REQUIRED), who picks it up, handover date, status and proof; a row with to_confirm set was drafted from the records and not yet confirmed by its holder, so say so. The answer is compact by default (every id, owner, status and date, long texts shortened, the whole board, never a cut read); detail: true returns every field. Quote ready and why as given, and link a blocker by its link. Read only.`,
  inputSchema: { type: 'object', properties: { full: { type: 'boolean', description: 'Every blocked loop, not the short list. Large.' }, blocked_owner: { type: 'string', description: "One person's blocked loops in full: a name (Jegan) or Slack id." }, detail: { type: 'boolean', description: 'Every field of every item and knowledge row, as the page has them. About 100,000 characters.' } }, additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, title: 'Read the Production-Income Board' },
  handler: async (args, deps) => {
    const t0 = Date.now();
    const [r, all, kc] = await Promise.all([board.read(), board.blockers(), knowledge.read()]);
    const owner = typeof args.blocked_owner === 'string' && args.blocked_owner.trim() ? args.blocked_owner : null;
    const blocked = args.full === true ? all : owner ? board.ownerBlockers(all, owner) : board.shortBlockers(all);
    await mirror
      .logWrite({ endpoint: 'mcp:read_income_board', kind: 'income_board', method: 'MCP', key_label: deps.access === 'write' ? 'MCP_WRITE_TOKEN' : 'MCP_SECRET', outcome: 'read', detail: `${r.ready} ${r.blocking.length} blocking`, ms: Date.now() - t0 })
      .catch(() => undefined);
    if (args.detail === true) return { ok: true, ...r, blocked_loops: blocked, knowledge_capture: kc };
    return { ok: true, ...compactForAgent(r as any, blocked as any, kc as any) };
  },
};

export const setIncomeBoardItem: ToolDefinition = {
  name: 'set_income_board_item',
  description: `Put a loop (LOOP-...) or Decision Watch (DW-...) on the Production-Income Board (${board.BOARD_KEY}) as something that blocks "${board.QUESTION}", change one already on it, or take one off. Each item sits in one of Jason's seven sections (${board.SECTION_KEYS.join(', ')}) and is BLOCKS_PILOT_1 or QUALITY_OF_LIFE; update changes only the section, impact or target_date sent (an empty target_date means date_to_set). The two gates (STAGE1_PASSED, CHARGE_GATE_OPEN) are always on the board: update sets their owner (a Slack id) and target_date, never whether they are true, and every change keeps the one before it with its reason. Only when Destiny (U0AEW3TBYH1) or Jason (U0A9V97949F) asks, in this conversation: pass them as requester_user_id; anyone else is refused. reason is required (what it blocks, or why it comes off); target_date (YYYY-MM-DD) is optional and only what the person said, never guessed. Nothing is deleted: a removal is dated and signed. dry_run checks and writes nothing. Audited on engine_mcp_writes (kind income_board).`,
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['add', 'update', 'remove'] },
      record_id: { type: 'string', description: 'LOOP-..., DW-..., or a gate: STAGE1_PASSED or CHARGE_GATE_OPEN (update only: owner and target_date).' },
      owner: { type: 'string', description: 'Gates only: the Slack id (U...) of who owns the gate.' },
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
      const r = await board.setItem({ action, record_id: String(args.record_id ?? ''), reason: typeof args.reason === 'string' ? args.reason : null, target_date: opt('target_date'), section: opt('section'), impact: opt('impact'), owner: opt('owner'), requester }, dry);
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
