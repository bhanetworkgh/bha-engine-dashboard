/**
 * The Production-Income Board, BOARD_PROD_INCOME_VFARM_CST (20 Nov 2026, Destiny; Jason in #bha-coordination,
 * 1795202126.334919: "a single, named board that answers: Ready for first paid Stage-1 greens vFarm pilot with
 * CST + Monitoring Twin: Yes/No? If No, which loops/watches (by ID) and lanes/owners/dates are blocking?").
 *
 * Two kinds of blocker, and nothing else decides the answer:
 *   - two gates read live from records that already exist: a real (non-fixture) Stage 1 record that has passed,
 *     and the charge gate (Hardik's green pass and Jason's approved offer, chargeGate.status().can_charge_live);
 *   - the board's items: loops and Decision Watches Destiny or Jason put on it (engine_income_board_items,
 *     migration 146). An item blocks while its loop is Open or In Progress, or its watch is still open.
 * Ready is Yes only when both gates pass, at least one item is held and none is open. No item held is No, with
 * the reason, never a Yes by default.
 *
 * Every item's state is read from its own record at read time (the loop's latest row, the watch's own row), so the
 * board can never disagree with the loop table. A target date is the item's own, else the loop's Due Date, else
 * "not set": never guessed.
 */
import { query } from './pg';
import * as chargeGate from './chargeGate';
import { ADMIN_IDS } from './writeGuards';

export const BOARD_KEY = 'BOARD_PROD_INCOME_VFARM_CST';
export const QUESTION = 'Ready for first paid Stage-1 greens vFarm pilot with CST + Monitoring Twin';
const PAGE = `${(process.env.PUBLIC_DASHBOARD_URL || 'https://dashboard.bhanetwork.org').replace(/\/+$/, '')}/income-board`;
const LOOP_PAGE = `${(process.env.PUBLIC_DASHBOARD_URL || 'https://dashboard.bhanetwork.org').replace(/\/+$/, '')}/open-loops/`;
/** A CST loop untouched this long is stalled. */
export const STALLED_DAYS = 7;
const OPEN_LOOP = new Set(['Open', 'In Progress']);
const OPEN_WATCH = new Set(['watching', 'escalating']);
const NAMES: Record<string, string> = {
  U0A9V97949F: 'Jason', U0AEW3TBYH1: 'Destiny', U0AF011R821: 'Jegan', U0BKT6MAW2Y: 'Hardik', U0AC6RFNP3P: 'Ahad', U0BNQGG020Y: 'Kavin',
  jason: 'Jason', destiny: 'Destiny', jegan: 'Jegan', hardik: 'Hardik', ahad: 'Ahad', kavin: 'Kavin',
};
const nameOf = (id: string | null | undefined) => (id ? NAMES[id] ?? NAMES[id.toLowerCase()] ?? id : null);

export interface ItemRow {
  id: string;
  kind: 'loop' | 'watch';
  record_id: string;
  reason: string;
  target_date: string | null;
  added_by: string;
  added_at: string;
}

export interface Blocker {
  kind: 'gate' | 'loop' | 'watch';
  id: string;
  title: string;
  status: string;
  open: boolean;
  lane: string | null;
  owner: string | null;
  target_date: string | null;
  reason: string;
  link: string | null;
}

/** Whether an item's own state is still blocking. Pure. */
export function stillOpen(kind: 'loop' | 'watch', status: string | null): boolean {
  if (status === null) return true; // a record that cannot be found is not shown as done
  return kind === 'loop' ? OPEN_LOOP.has(status) : OPEN_WATCH.has(status);
}

/** The answer, from the gates and the items. Pure. */
export function decide(gates: Blocker[], items: Blocker[]): { ready: boolean; why: string } {
  const failing = gates.filter((g) => g.open);
  const open = items.filter((i) => i.open);
  if (!items.length) return { ready: false, why: 'No blocking loop or watch has been put on the board yet, so it cannot say Yes.' };
  if (failing.length || open.length) {
    const parts = [];
    if (failing.length) parts.push(`${failing.length} gate${failing.length === 1 ? '' : 's'} not passed`);
    if (open.length) parts.push(`${open.length} of ${items.length} item${items.length === 1 ? '' : 's'} still open`);
    return { ready: false, why: `${parts.join(' and ')}.` };
  }
  return { ready: true, why: `Both gates passed and all ${items.length} items are closed.` };
}

async function gates(): Promise<{ list: Blocker[]; errors: string[] }> {
  const errors: string[] = [];
  const list: Blocker[] = [];
  try {
    const s1 = (await query<{ object_id: string; status: string; fields: Record<string, unknown> }>(
      `SELECT object_id, status, fields FROM engine_vfarm_gates WHERE kind = 'stage1' AND is_fixture = false ORDER BY (status = 'passed') DESC, updated_at DESC LIMIT 1`,
    )).rows[0];
    list.push({
      kind: 'gate',
      id: 'STAGE1_PASSED',
      title: 'A real Stage 1 validation record has passed (all four checks)',
      status: s1 ? s1.status : 'no real Stage 1 record',
      open: !s1 || s1.status !== 'passed',
      lane: 'VFARM_HARDWARE',
      owner: null,
      target_date: s1 && typeof s1.fields.target_date === 'string' ? s1.fields.target_date : null,
      reason: s1 ? `Newest real Stage 1 record ${s1.object_id} is ${s1.status}.` : 'No real (non-fixture) Stage 1 record is held.',
      link: `${PAGE.replace('/income-board', '')}/vfarm?tab=gates`,
    });
  } catch (e) {
    errors.push(`Stage 1 gate: ${(e as Error).message}`);
    list.push({ kind: 'gate', id: 'STAGE1_PASSED', title: 'A real Stage 1 validation record has passed', status: 'unread', open: true, lane: 'VFARM_HARDWARE', owner: null, target_date: null, reason: 'Could not be read, so it counts as not passed.', link: null });
  }
  try {
    const cg = await chargeGate.status();
    list.push({
      kind: 'gate',
      id: 'CHARGE_GATE',
      title: "Real buyers may be charged (Hardik's green acceptance pass and Jason's approved offer)",
      status: cg.can_charge_live ? 'can charge' : 'cannot charge yet',
      open: !cg.can_charge_live,
      lane: 'CST',
      owner: null,
      target_date: null,
      reason: cg.answer,
      link: null,
    });
  } catch (e) {
    errors.push(`charge gate: ${(e as Error).message}`);
    list.push({ kind: 'gate', id: 'CHARGE_GATE', title: 'Real buyers may be charged', status: 'unread', open: true, lane: 'CST', owner: null, target_date: null, reason: 'Could not be read, so it counts as no.', link: null });
  }
  return { list, errors };
}

export async function items(): Promise<ItemRow[]> {
  return (await query<ItemRow>(
    `SELECT id::text, kind, record_id, reason, target_date::text, added_by, to_char(added_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS added_at
       FROM engine_income_board_items WHERE board_key = $1 AND removed_at IS NULL ORDER BY added_at, id`,
    [BOARD_KEY],
  )).rows;
}

async function resolve(rows: ItemRow[]): Promise<Blocker[]> {
  const loopIds = rows.filter((r) => r.kind === 'loop').map((r) => r.record_id);
  const watchIds = rows.filter((r) => r.kind === 'watch').map((r) => r.record_id);
  const loops = new Map(
    (loopIds.length
      ? (await query<{ natural_id: string; fields: Record<string, unknown>; builder_id: string | null }>(
          `SELECT DISTINCT ON (natural_id) natural_id, fields, builder_id FROM engine_loops WHERE natural_id = ANY($1) ORDER BY natural_id, updated_at DESC`,
          [loopIds],
        )).rows
      : []
    ).map((l) => [l.natural_id, l]),
  );
  const watches = new Map(
    (watchIds.length
      ? (await query<{ watch_id: string; decision: string; status: string; owner_user_id: string; lane: string | null; thread_link: string | null }>(
          `SELECT watch_id, decision, status, owner_user_id, lane, thread_link FROM engine_decision_watches WHERE watch_id = ANY($1)`,
          [watchIds],
        )).rows
      : []
    ).map((w) => [w.watch_id, w]),
  );
  return rows.map((r) => {
    if (r.kind === 'loop') {
      const l = loops.get(r.record_id);
      const f = l?.fields ?? {};
      const status = l ? String(f.Status ?? '') : null;
      const due = typeof f['Due Date'] === 'string' && f['Due Date'] ? String(f['Due Date']).slice(0, 10) : null;
      return {
        kind: 'loop', id: r.record_id,
        title: l ? String(f.What ?? '').split('\n')[0].slice(0, 220) : 'Not held: no loop with this id',
        status: status ?? 'not held', open: stillOpen('loop', status),
        lane: l ? (f.lane_tag ? String(f.lane_tag) : null) : null,
        owner: l ? nameOf(String(f['Assignee Slack User ID'] ?? '') || l.builder_id) : null,
        target_date: r.target_date ?? due, reason: r.reason, link: `${LOOP_PAGE}${r.record_id}`,
      };
    }
    const w = watches.get(r.record_id);
    return {
      kind: 'watch', id: r.record_id,
      title: w ? w.decision.split('\n')[0].slice(0, 220) : 'Not held: no watch with this id',
      status: w ? w.status : 'not held', open: stillOpen('watch', w ? w.status : null),
      lane: w?.lane ?? null, owner: w ? nameOf(w.owner_user_id) : null,
      target_date: r.target_date, reason: r.reason, link: w?.thread_link ?? null,
    };
  });
}

async function cstSummary() {
  const loops = (await query<{ natural_id: string; status: string; what: string; owner: string | null; days: number }>(
    `WITH l AS (SELECT DISTINCT ON (natural_id) natural_id, fields, builder_id, updated_at FROM engine_loops ORDER BY natural_id, updated_at DESC)
     SELECT natural_id, fields->>'Status' AS status, split_part(fields->>'What', E'\\n', 1) AS what, COALESCE(fields->>'Assignee Slack User ID', builder_id) AS owner,
            floor(extract(epoch FROM now() - updated_at) / 86400)::int AS days
       FROM l WHERE fields->>'lane_tag' = 'CST' AND fields->>'Status' IN ('Open', 'In Progress') ORDER BY updated_at`,
  )).rows;
  const watches = Number((await query<{ n: string }>(`SELECT count(*) AS n FROM engine_decision_watches WHERE lane = 'CST' AND status IN ('watching', 'escalating') AND fixture = false`)).rows[0]?.n ?? 0);
  const stalled = loops.filter((l) => l.days >= STALLED_DAYS);
  return {
    open_loops: loops.length,
    moving: loops.length - stalled.length,
    stalled: stalled.length,
    stalled_rule: `A CST loop with no change for ${STALLED_DAYS} days or more is stalled; anything changed since is moving.`,
    open_watches: watches,
    stalled_loops: stalled.slice(0, 15).map((l) => ({ loop_id: l.natural_id, what: l.what.slice(0, 160), owner: nameOf(l.owner), days_since_change: l.days, link: `${LOOP_PAGE}${l.natural_id}` })),
  };
}

export async function read() {
  const [g, rows] = await Promise.all([gates(), items()]);
  const resolved = await resolve(rows);
  const verdict = decide(g.list, resolved);
  let cst: Awaited<ReturnType<typeof cstSummary>> | null = null;
  let cstError: string | null = null;
  try {
    cst = await cstSummary();
  } catch (e) {
    cstError = (e as Error).message;
  }
  const blocking = [...g.list, ...resolved].filter((b) => b.open);
  return {
    board_key: BOARD_KEY,
    question: QUESTION,
    ready: verdict.ready ? 'Yes' : 'No',
    why: verdict.why,
    blocking,
    gates: g.list,
    items: resolved,
    items_closed: resolved.filter((i) => !i.open).length,
    cst,
    read_errors: [...g.errors, ...(cstError ? [`CST summary: ${cstError}`] : [])],
    rule: 'Ready is Yes only when a real Stage 1 record has passed, real buyers may be charged, and every loop and watch on the board is closed. Items are put on the board by Destiny or Jason. An item that cannot be read counts as open.',
    page: PAGE,
    read_at: new Date().toISOString(),
  };
}

/* ------------------------------------------------------------------ writes */

export interface SetInput {
  action: 'add' | 'remove';
  record_id: string;
  reason?: string | null;
  target_date?: string | null;
  requester: string | null;
}

const LOOP_RE = /^LOOP-\d{10,}-[A-Z0-9]{4}$/;
const WATCH_RE = /^DW-\d{10,}-[A-Z0-9]{4}$/;

/** Adds or removes one item. Only Destiny or Jason. Nothing is deleted: a removal is dated and signed. */
export async function setItem(i: SetInput, dryRun = false): Promise<Record<string, unknown>> {
  if (!i.requester || !ADMIN_IDS.includes(i.requester)) return { ok: false, reason: 'not_permitted', message: 'Only Destiny (U0AEW3TBYH1) or Jason (U0A9V97949F) changes what is on the Production-Income Board.' };
  const id = (i.record_id ?? '').trim();
  const kind = LOOP_RE.test(id) ? 'loop' : WATCH_RE.test(id) ? 'watch' : null;
  if (!kind) return { ok: false, reason: 'bad_record_id', message: 'record_id is a full loop id (LOOP-...) or Decision Watch id (DW-...).' };
  const reason = (i.reason ?? '').trim();
  if (reason.length < 3) return { ok: false, reason: 'reason_required', message: 'Say why, in a few words: what it blocks, or why it comes off.' };
  if (i.action === 'add') {
    const td = (i.target_date ?? '').trim() || null;
    if (td && !/^\d{4}-\d{2}-\d{2}$/.test(td)) return { ok: false, reason: 'bad_target_date', message: 'target_date is YYYY-MM-DD.' };
    const exists = kind === 'loop'
      ? (await query(`SELECT 1 FROM engine_loops WHERE natural_id = $1 LIMIT 1`, [id])).rowCount
      : (await query(`SELECT 1 FROM engine_decision_watches WHERE watch_id = $1 LIMIT 1`, [id])).rowCount;
    if (!exists) return { ok: false, reason: 'not_held', message: `${id} is not held on the dashboard.` };
    const held = (await query(`SELECT 1 FROM engine_income_board_items WHERE board_key = $1 AND record_id = $2 AND removed_at IS NULL`, [BOARD_KEY, id])).rowCount;
    if (held) return { ok: false, reason: 'already_on_board', message: `${id} is already on the board.` };
    if (dryRun) return { ok: true, dry_run: true, would: `add ${kind} ${id}` };
    await query(`INSERT INTO engine_income_board_items (board_key, kind, record_id, reason, target_date, added_by) VALUES ($1, $2, $3, $4, $5, $6)`, [BOARD_KEY, kind, id, reason.slice(0, 600), td, i.requester]);
    return { ok: true, added: id, kind, page: PAGE };
  }
  const held = (await query(`SELECT 1 FROM engine_income_board_items WHERE board_key = $1 AND record_id = $2 AND removed_at IS NULL`, [BOARD_KEY, id])).rowCount;
  if (!held) return { ok: false, reason: 'not_on_board', message: `${id} is not on the board.` };
  if (dryRun) return { ok: true, dry_run: true, would: `remove ${id}` };
  await query(`UPDATE engine_income_board_items SET removed_at = now(), removed_by = $3, removed_reason = $4 WHERE board_key = $1 AND record_id = $2 AND removed_at IS NULL`, [BOARD_KEY, id, i.requester, reason.slice(0, 600)]);
  return { ok: true, removed: id, page: PAGE };
}
