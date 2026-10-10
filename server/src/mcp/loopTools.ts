/**
 * Move a loop to another builder over MCP (9 Oct 2026, Destiny).
 *
 *   move_loop — write connection only. The Open loops page's own builder
 *               change (store.editLoop, the function the page's save calls),
 *               so the rules are the page's: the builder is which table a row
 *               sits in, the loop_id travels unchanged, the assignee is set
 *               from the destination, and the status events, note and write
 *               log follow the row.
 *
 * Built because six loops sat on Destiny's table while naming Jason or Jegan
 * as the person responsible, and the only way to move one was a person
 * clicking the page: update_record changes fields, and the builder is not a
 * field. Asking Bays to do it re-created the loop under a new id.
 *
 * Who may move a loop: Destiny or Jason, the builder whose table it sits on,
 * or its current assignee. A loop held more than once under one loop_id (a
 * copy left behind by an earlier move) is refused and both rows are named,
 * never picked between. Every call is audited on engine_mcp_writes, refused
 * and dry-run ones included.
 */
import { query } from '../pg';
import * as store from '../store';
import * as loops from '../loops';
import { LOOP_TABLES } from '../sources';
import { ADMIN_IDS } from '../writeGuards';
import { auditClose, auditOpen } from './writeTools';
import type { ToolDefinition } from './tools';

const OWNERS = LOOP_TABLES.map((t) => t.owner);

export const moveLoopTool: ToolDefinition = {
  name: 'move_loop',
  description:
    `Move one open loop to another builder's table — the Open loops page's own builder change, through the same function. The builder IS the table a loop sits on, so this is a move, not a field edit: the loop_id stays the same, the assignee becomes the new owner, and the loop's history follows it. loop_id: the loop (LOOP-…). to_builder: one of ${OWNERS.join(', ')}. requester_user_id: the Slack id of the person asking (required); Destiny or Jason may move any loop, anyone else only a loop on their own table or assigned to them. reason: why it is moving (kept on the audit line). dry_run: say what would happen without moving it. Refused when the loop is not held, is already on that table, or is held twice under one loop_id (both rows are named). Returns {ok, loop_id, from_builder, to_builder, assignee}. Audited on engine_mcp_writes.`,
  inputSchema: {
    type: 'object',
    properties: {
      loop_id: { type: 'string', description: 'The loop to move, e.g. LOOP-1788818316100-4QA2.' },
      to_builder: { type: 'string', description: `The builder whose table it moves to: ${OWNERS.join(', ')}.` },
      requester_user_id: { type: 'string', description: 'Slack id of the person asking. Required.' },
      reason: { type: 'string', description: 'Why it is moving, for the audit line.' },
      dry_run: { type: 'boolean', description: 'Check the call and say what would move, without moving it.' },
    },
    required: ['loop_id', 'to_builder', 'requester_user_id'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false, title: 'Move a loop to another builder' },
  handler: async (args, deps) => {
    const loopId = typeof args.loop_id === 'string' ? args.loop_id.trim() : '';
    const to = typeof args.to_builder === 'string' ? args.to_builder.trim().toLowerCase() : '';
    const requester = typeof args.requester_user_id === 'string' ? args.requester_user_id.trim() || null : null;
    const reason = typeof args.reason === 'string' ? args.reason.trim().slice(0, 300) : '';
    const dry = args.dry_run === true;
    const audit = await auditOpen({ tool: 'move_loop', args, access: deps.access, kind: 'loops', requester, dry_run: dry });
    const refuse = async (why: string, message: string, extra: Record<string, unknown> = {}) => {
      await auditClose(audit, { outcome: 'refused', detail: `${why}: ${message}`, natural_id: loopId || null, guard_result: { reason: why, ...extra } });
      return { ok: false, moved: false, reason: why, message: `${message} Nothing was moved.`, ...extra, audit_id: audit };
    };

    if (!loopId) return refuse('bad_argument', 'Send loop_id: the loop to move.');
    if (!requester) return refuse('who_is_required', 'Send requester_user_id: the Slack id of the person asking. Every move names who asked for it.');
    if (!OWNERS.includes(to)) return refuse('unknown_builder', `"${String(args.to_builder ?? '')}" is not a builder with a loop table. One of: ${OWNERS.join(', ')}.`, { builders: OWNERS });

    const held = await query<{ id: string; builder_id: string | null; status: string | null; assignee: string | null; what: string | null }>(
      `SELECT id, builder_id, fields->>'Status' AS status, fields->>'Assignee Slack User ID' AS assignee, left(fields->>'What', 160) AS what
         FROM engine_loops WHERE natural_id = $1 ORDER BY id`,
      [loopId],
    );
    if (!held.rows.length) return refuse('not_found', `No loop "${loopId}" is held.`);
    if (held.rows.length > 1) {
      return refuse('held_twice', `${loopId} is held ${held.rows.length} times (rows ${held.rows.map((r) => `${r.id} on ${r.builder_id ?? 'no table'}`).join(', ')}): a copy was left behind by an earlier move. Remove the copy first; this will not pick one.`, {
        rows: held.rows.map((r) => ({ id: r.id, builder: r.builder_id, status: r.status })),
      });
    }
    const row = held.rows[0];
    const from = row.builder_id;
    if (from === to) return refuse('already_there', `${loopId} is already on ${to}'s table.`, { from_builder: from });

    const ownTable = LOOP_TABLES.find((t) => t.owner === from);
    const requesterBuilder = store.builderForSlackId(requester);
    const allowed = ADMIN_IDS.includes(requester) || row.assignee === requester || (requesterBuilder !== null && ownTable !== undefined && requesterBuilder === from);
    if (!allowed) return refuse('not_permitted', `${loopId} sits on ${from ?? 'no'}'s table and is assigned to ${row.assignee ?? 'nobody'}. Only Destiny, Jason, that builder or the assignee can move it.`, { from_builder: from });

    const plan = { loop_id: loopId, from_builder: from, to_builder: to, status: row.status, what: row.what, assignee_becomes: store.slackIdForBuilder(to) };
    if (dry) {
      await auditClose(audit, { outcome: 'dry_run', detail: `would move ${loopId} from ${from} to ${to}`, record_id: row.id, natural_id: loopId, guard_result: plan });
      return { ok: true, moved: false, dry_run: true, ...plan, message: `Dry run: nothing was moved. This would move ${loopId} from ${from}'s table to ${to}'s, and the assignee would become ${plan.assignee_becomes ?? 'unset'}.`, audit_id: audit };
    }

    try {
      const actor = `mcp:${deps.access} (${requester})${reason ? ` — ${reason}` : ''}`;
      await store.editLoop(`row-${row.id}`, { builder: to }, actor);
      const after = await query<{ id: string; builder_id: string | null; assignee: string | null }>(`SELECT id, builder_id, fields->>'Assignee Slack User ID' AS assignee FROM engine_loops WHERE natural_id = $1 ORDER BY id`, [loopId]);
      const now = after.rows.find((r) => r.builder_id === to);
      if (!now || after.rows.length !== 1) {
        const message = `The move was asked for, but ${loopId} now reads ${after.rows.map((r) => `row ${r.id} on ${r.builder_id ?? 'no table'}`).join(', ') || 'no row'}. Check the loop on the Open loops page.`;
        await auditClose(audit, { outcome: 'failed', detail: message, record_id: row.id, natural_id: loopId, before: plan, after: after.rows });
        return { ok: false, moved: false, reason: 'not_moved', message, raise: true, audit_id: audit };
      }
      await auditClose(audit, { outcome: 'updated', detail: `moved ${loopId} from ${from} to ${to}${reason ? ` (${reason})` : ''}`, record_id: now.id, natural_id: loopId, before: { builder: from, assignee: row.assignee }, after: { builder: now.builder_id, assignee: now.assignee } });
      return { ok: true, moved: true, loop_id: loopId, from_builder: from, to_builder: now.builder_id, assignee: now.assignee, message: `Moved ${loopId} from ${from}'s table to ${to}'s. The loop id is unchanged.`, audit_id: audit };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const refusal = e instanceof loops.LoopError || e instanceof store.StoreError;
      await auditClose(audit, { outcome: refusal ? 'refused' : 'failed', detail: message, record_id: row.id, natural_id: loopId });
      return { ok: false, moved: false, reason: refusal ? 'refused' : 'error', message: `${message} Nothing was moved.`, ...(refusal ? {} : { raise: true }), audit_id: audit };
    }
  },
};

export const LOOP_WRITE_TOOLS: ToolDefinition[] = [moveLoopTool];
