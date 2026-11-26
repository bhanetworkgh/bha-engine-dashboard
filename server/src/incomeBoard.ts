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

/**
 * Income Board v2 (23 Nov 2026, Destiny; Jason in DM D0AF0DG8ZPY 1795035372.309459): Jason's seven sections, a
 * BLOCKS_PILOT_1 or QUALITY_OF_LIFE label on every item, a target date or date_to_set with slips shown, lane-owner
 * views, and the two gate fields read from the records only.
 */
export const SECTIONS = [
  { key: 'cst_gate_a', label: 'CST Gate A', covers: 'API health (/api/health with api_reachability and farm_health for vFarm), auth and tenant wiring, anything missing to call the gate ready' },
  { key: 'rover', label: 'Rover', covers: 'the field data path to CST and the Monitoring Twin, and rover hardware and firmware that affects CST' },
  { key: 'incident_spine', label: 'Incident spine', covers: 'how incidents from vFarm get into CST, and their mapping to incident codes and triage' },
  { key: 'config_cabinet', label: 'Config + cabinet', covers: 'cabinet and config state as CST sees it, the Stage 1 proof on the racks, and the keys CST depends on' },
  { key: 'alerts_monitoring', label: 'Alerts + monitoring', covers: 'vFarm alerts into CST and the Monitoring Twin, false-offline noise, what is missing before alerts can be trusted in production' },
  { key: 'cst_vfarm_integration', label: 'CST + vFarm integration', covers: 'the signals that flow both ways (alerts, incidents, rover and edge data), and what CST knows about a pilot cabinet' },
  { key: 'slack_pilot_intake', label: 'Slack pilot + intake', covers: 'the Slack pilot channel, and how an Early Access lead or pilot client shows up in CST (Intake-2)' },
] as const;
export type SectionKey = (typeof SECTIONS)[number]['key'];
export const SECTION_KEYS: readonly string[] = SECTIONS.map((x) => x.key);
export const IMPACTS = ['BLOCKS_PILOT_1', 'QUALITY_OF_LIFE'] as const;
export type Impact = (typeof IMPACTS)[number];
/** Jason's owner slices: what each person owns that blocks Pilot 1. Hardik and Destiny share one view. */
export const OWNER_VIEWS = [
  { key: 'ahad', label: 'Ahad', owners: ['Ahad'] },
  { key: 'jegan', label: 'Jegan', owners: ['Jegan'] },
  { key: 'kavin', label: 'Kavin', owners: ['Kavin'] },
  { key: 'hardik_destiny', label: 'Hardik and Destiny', owners: ['Hardik', 'Destiny'] },
  { key: 'jason', label: 'Jason', owners: ['Jason'] },
] as const;
/** STAGE1_PASSED needs a real passed Stage 1 record naming each of these loops (Jason, 22 Nov). */
export const STAGE1_LOOPS = ['LOOP-1794856525804-H9KF', 'LOOP-1791587880697-L4WA'] as const;
/** CHARGE_GATE_OPEN also needs one live end-to-end payment above the $1 team tests (amount in cents). */
export const TEAM_TEST_CENTS = 100;
/** "Moved this week" looks back this far. */
export const WEEK_DAYS = 7;

export interface ItemRow {
  id: string;
  kind: 'loop' | 'watch';
  record_id: string;
  reason: string;
  target_date: string | null;
  section: string | null;
  impact: string | null;
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
  /** set: dated and not yet due; date_to_set: open with no date; slipped: open and past its date; closed: done. */
  date_state: 'set' | 'date_to_set' | 'slipped' | 'closed';
  days_slipped: number | null;
  section: string | null;
  section_label: string | null;
  impact: Impact;
  last_change: string | null;
  moved_this_week: boolean;
  reason: string;
  link: string | null;
}

/** Whether an item's own state is still blocking. Pure. */
export function stillOpen(kind: 'loop' | 'watch', status: string | null): boolean {
  if (status === null) return true; // a record that cannot be found is not shown as done
  return kind === 'loop' ? OPEN_LOOP.has(status) : OPEN_WATCH.has(status);
}

/** Where an item's date stands. Pure. today is YYYY-MM-DD. */
export function dateState(target: string | null, open: boolean, today: string): { date_state: Blocker['date_state']; days_slipped: number | null } {
  if (!open) return { date_state: 'closed', days_slipped: null };
  if (!target) return { date_state: 'date_to_set', days_slipped: null };
  if (target < today) return { date_state: 'slipped', days_slipped: Math.round((Date.parse(today) - Date.parse(target)) / 86_400_000) };
  return { date_state: 'set', days_slipped: null };
}

/** An item with no label counts as blocking: the safe direction. Pure. */
export function impactOf(v: string | null | undefined): Impact {
  return v === 'QUALITY_OF_LIFE' ? 'QUALITY_OF_LIFE' : 'BLOCKS_PILOT_1';
}

/** The answer, from the gates and the items. Only BLOCKS_PILOT_1 items hold it at No. Pure. */
export function decide(gates: Blocker[], items: Blocker[]): { ready: boolean; why: string } {
  const failing = gates.filter((g) => g.open);
  const blocking = items.filter((i) => i.impact === 'BLOCKS_PILOT_1');
  const open = blocking.filter((i) => i.open);
  if (!blocking.length) return { ready: false, why: 'No item that blocks Pilot 1 has been put on the board yet, so it cannot say Yes.' };
  if (failing.length || open.length) {
    const parts = [];
    if (failing.length) parts.push(`${failing.map((g) => g.id).join(' and ')} ${failing.length === 1 ? 'is' : 'are'} false`);
    if (open.length) parts.push(`${open.length} of ${blocking.length} board item${blocking.length === 1 ? '' : 's'} that block Pilot 1 still open`);
    // 26 Nov 2026: "16 of 17" read as disagreeing with a blocking list of 18. The list is the open items plus the gates.
    const total = open.length + failing.length;
    return { ready: false, why: `${parts.join(', and ')}: ${total} open blocker${total === 1 ? '' : 's'} in all (${open.length} item${open.length === 1 ? '' : 's'} plus ${failing.length} gate${failing.length === 1 ? '' : 's'}).` };
  }
  return { ready: true, why: `STAGE1_PASSED and CHARGE_GATE_OPEN are both true and all ${blocking.length} items that block Pilot 1 are closed.` };
}

/** STAGE1_PASSED, from the Stage 1 records alone. Pure. */
export function stage1Passed(records: { object_id: string; status: string; loop_ref: string | null }[]): { passed: boolean; per_loop: { loop_id: string; record: string | null; state: string }[] } {
  const per_loop = STAGE1_LOOPS.map((loop) => {
    const suffix = loop.slice(-4);
    const mine = records.filter((r) => r.loop_ref && (r.loop_ref === loop || r.loop_ref.endsWith(suffix)));
    const passed = mine.find((r) => r.status === 'passed');
    return { loop_id: loop, record: passed?.object_id ?? mine[0]?.object_id ?? null, state: passed ? 'passed' : mine[0] ? mine[0].status : 'no real Stage 1 record names this loop' };
  });
  return { passed: per_loop.every((x) => x.state === 'passed'), per_loop };
}

/** The two gates (26 Nov 2026, Jason in C0ASMPYQLG3 1795696380.626199: a gate with no owner and no date is a fault). */
export const GATE_IDS = ['STAGE1_PASSED', 'CHARGE_GATE_OPEN'] as const;
type GateSet = { owner: string | null; target_date: string | null; set_by: string; set_at: string; reason: string };

/**
 * Who owns each gate and when it is due. Whether a gate is true is still read from the records only; the owner and
 * the date are set by Destiny or Jason, append-only, newest wins, with the reason kept (engine_income_board_gate_sets).
 */
export async function gateSets(): Promise<Record<string, GateSet>> {
  const r = await query<GateSet & { gate_id: string }>(
    `SELECT DISTINCT ON (gate_id) gate_id, owner, target_date::text AS target_date, set_by, to_char(set_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS set_at, reason
       FROM engine_income_board_gate_sets WHERE board_key = $1 ORDER BY gate_id, set_at DESC, id DESC`,
    [BOARD_KEY],
  );
  return Object.fromEntries(r.rows.map((x) => [x.gate_id, x]));
}

function gateRow(id: string, title: string, open: boolean, status: string, reason: string, lane: string, link: string | null, today: string, set?: GateSet): Blocker {
  const target = set?.target_date ?? null;
  return { kind: 'gate', id, title, status, open, lane, owner: set?.owner ? nameOf(set.owner) : null, target_date: target, ...dateState(target, open, today), section: null, section_label: null, impact: 'BLOCKS_PILOT_1', last_change: set?.set_at ?? null, moved_this_week: false, reason, link };
}

async function gates(today: string): Promise<{ list: Blocker[]; errors: string[] }> {
  const errors: string[] = [];
  const list: Blocker[] = [];
  let sets: Record<string, GateSet> = {};
  try {
    sets = await gateSets();
  } catch (e) {
    errors.push(`gate owners and dates: ${(e as Error).message}`);
  }
  const vfarmPage = `${PAGE.replace('/income-board', '')}/vfarm?tab=gates`;
  try {
    const recs = (await query<{ object_id: string; status: string; loop_ref: string | null }>(
      `SELECT object_id, status, fields->>'loop_ref' AS loop_ref FROM engine_vfarm_gates WHERE kind = 'stage1' AND is_fixture = false ORDER BY updated_at DESC`,
    )).rows;
    const s = stage1Passed(recs);
    list.push(gateRow('STAGE1_PASSED', 'A real Stage 1 record has passed for both H9KF (production rack) and L4WA (Kavin\'s rack)', !s.passed, s.passed ? 'true' : 'false',
      s.per_loop.map((x) => `${x.loop_id.slice(-4)}: ${x.record ? `${x.record} ${x.state}` : x.state}`).join('; ') + '.', 'VFARM_HARDWARE', vfarmPage, today, sets.STAGE1_PASSED));
  } catch (e) {
    errors.push(`STAGE1_PASSED: ${(e as Error).message}`);
    list.push(gateRow('STAGE1_PASSED', 'A real Stage 1 record has passed for both H9KF and L4WA', true, 'unread', 'Could not be read, so it counts as false.', 'VFARM_HARDWARE', null, today, sets.STAGE1_PASSED));
  }
  try {
    const cg = await chargeGate.status();
    const pay = (await query<{ n: string; biggest: string | null }>(
      `SELECT count(*) AS n, max(amount)::text AS biggest FROM engine_stripe_events WHERE type = 'checkout.session.completed' AND livemode = true AND outcome = 'recorded' AND amount > $1`,
      [TEAM_TEST_CENTS],
    )).rows[0];
    const paid = Number(pay?.n ?? 0) > 0;
    const parts = [
      cg.can_charge_live ? "Jason's offer approval and Hardik's acceptance pass are recorded." : `Charge gate: ${cg.missing.join('; ')}.`,
      paid ? `A live end-to-end payment above $1 is recorded (largest $${(Number(pay?.biggest) / 100).toFixed(2)}).` : 'No live end-to-end payment above the $1 team tests is recorded yet.',
    ];
    list.push(gateRow('CHARGE_GATE_OPEN', "Real buyers may be charged: Jason's offer_approved recorded, the charge gate open, and one live end-to-end payment beyond the $1 team test",
      !(cg.can_charge_live && paid), cg.can_charge_live && paid ? 'true' : 'false', parts.join(' '), 'CST', null, today, sets.CHARGE_GATE_OPEN));
  } catch (e) {
    errors.push(`CHARGE_GATE_OPEN: ${(e as Error).message}`);
    list.push(gateRow('CHARGE_GATE_OPEN', 'Real buyers may be charged', true, 'unread', 'Could not be read, so it counts as false.', 'CST', null, today, sets.CHARGE_GATE_OPEN));
  }
  return { list, errors };
}

export async function items(): Promise<ItemRow[]> {
  return (await query<ItemRow>(
    `SELECT id::text, kind, record_id, reason, target_date::text, section, impact, added_by, to_char(added_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS added_at
       FROM engine_income_board_items WHERE board_key = $1 AND removed_at IS NULL ORDER BY added_at, id`,
    [BOARD_KEY],
  )).rows;
}

const sectionLabel = (k: string | null) => SECTIONS.find((x) => x.key === k)?.label ?? null;

async function resolve(rows: ItemRow[], now: Date): Promise<Blocker[]> {
  const today = now.toISOString().slice(0, 10);
  const weekAgo = new Date(now.getTime() - WEEK_DAYS * 86_400_000).toISOString();
  const loopIds = rows.filter((r) => r.kind === 'loop').map((r) => r.record_id);
  const watchIds = rows.filter((r) => r.kind === 'watch').map((r) => r.record_id);
  const loops = new Map(
    (loopIds.length
      ? (await query<{ natural_id: string; fields: Record<string, unknown>; builder_id: string | null; updated_at: string }>(
          `SELECT DISTINCT ON (natural_id) natural_id, fields, builder_id, updated_at::text FROM engine_loops WHERE natural_id = ANY($1) ORDER BY natural_id, updated_at DESC`,
          [loopIds],
        )).rows
      : []
    ).map((l) => [l.natural_id, l]),
  );
  const watches = new Map(
    (watchIds.length
      ? (await query<{ watch_id: string; decision: string; status: string; owner_user_id: string; lane: string | null; thread_link: string | null; changed: string | null }>(
          `SELECT watch_id, decision, status, owner_user_id, lane, thread_link,
                  to_char(GREATEST(created_at, COALESCE(closed_at, created_at)) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS changed
             FROM engine_decision_watches WHERE watch_id = ANY($1)`,
          [watchIds],
        )).rows
      : []
    ).map((w) => [w.watch_id, w]),
  );
  return rows.map((r) => {
    const common = { section: r.section, section_label: sectionLabel(r.section), impact: impactOf(r.impact), reason: r.reason };
    if (r.kind === 'loop') {
      const l = loops.get(r.record_id);
      const f = l?.fields ?? {};
      const status = l ? String(f.Status ?? '') : null;
      const open = stillOpen('loop', status);
      const due = typeof f['Due Date'] === 'string' && f['Due Date'] ? String(f['Due Date']).slice(0, 10) : null;
      const target = r.target_date ?? due;
      const changed = l?.updated_at ? new Date(l.updated_at).toISOString() : null;
      return {
        kind: 'loop', id: r.record_id,
        title: l ? String(f.What ?? '').split('\n')[0].slice(0, 220) : 'Not held: no loop with this id',
        status: status ?? 'not held', open,
        lane: l ? (f.lane_tag ? String(f.lane_tag) : null) : null,
        owner: l ? nameOf(String(f['Assignee Slack User ID'] ?? '') || l.builder_id) : null,
        target_date: target, ...dateState(target, open, today), last_change: changed, moved_this_week: !!changed && changed >= weekAgo,
        ...common, link: `${LOOP_PAGE}${r.record_id}`,
      } as Blocker;
    }
    const w = watches.get(r.record_id);
    const open = stillOpen('watch', w ? w.status : null);
    return {
      kind: 'watch', id: r.record_id,
      title: w ? w.decision.split('\n')[0].slice(0, 220) : 'Not held: no watch with this id',
      status: w ? w.status : 'not held', open,
      lane: w?.lane ?? null, owner: w ? nameOf(w.owner_user_id) : null,
      target_date: r.target_date, ...dateState(r.target_date, open, today), last_change: w?.changed ?? null, moved_this_week: !!w?.changed && w.changed >= weekAgo,
      ...common, link: w?.thread_link ?? null,
    } as Blocker;
  });
}

async function cstSummary() {
  const loops = (await query<{ natural_id: string; status: string; what: string; owner: string | null; days: number }>(
    `WITH l AS (SELECT DISTINCT ON (natural_id) natural_id, fields, builder_id, updated_at FROM engine_loops ORDER BY natural_id, updated_at DESC)
     SELECT natural_id, fields->>'Status' AS status, split_part(fields->>'What', E'\\n', 1) AS what, COALESCE(fields->>'Assignee Slack User ID', builder_id) AS owner,
            floor(extract(epoch FROM now() - updated_at::timestamptz) / 86400)::int AS days
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

export interface SectionView { key: string; label: string; covers: string; done: string[]; remaining: string[]; blocks_pilot_open: number; empty_note: string | null }

/** The seven sections, each with the ids done and remaining (the rows are in items). Pure. */
export function bySection(items: Blocker[]): SectionView[] {
  const views: SectionView[] = SECTIONS.map((sec) => {
    const mine = items.filter((i) => i.section === sec.key);
    return {
      key: sec.key, label: sec.label, covers: sec.covers,
      done: mine.filter((i) => !i.open).map((i) => i.id),
      remaining: mine.filter((i) => i.open).map((i) => i.id),
      blocks_pilot_open: mine.filter((i) => i.open && i.impact === 'BLOCKS_PILOT_1').length,
      empty_note: mine.length ? null : 'Nothing on the board in this section yet: no loop or watch has been put here.',
    };
  });
  return views.concat(items.some((i) => !i.section || !SECTION_KEYS.includes(i.section))
    ? [{ key: 'unsectioned', label: 'Not in a section yet', covers: 'items put on the board without a section', done: items.filter((i) => (!i.section || !SECTION_KEYS.includes(i.section)) && !i.open).map((i) => i.id), remaining: items.filter((i) => (!i.section || !SECTION_KEYS.includes(i.section)) && i.open).map((i) => i.id), blocks_pilot_open: 0, empty_note: null }]
    : []);
}

/** What each lane owner owes next that blocks Pilot 1, soonest date first, undated last. Pure. */
export function ownerViews(items: Blocker[]) {
  const order = (a: Blocker, b: Blocker) => (a.target_date ?? '9999').localeCompare(b.target_date ?? '9999');
  return OWNER_VIEWS.map((v) => {
    const mine = items.filter((i) => i.open && i.owner && (v.owners as readonly string[]).includes(i.owner));
    return {
      key: v.key, label: v.label,
      blocks_pilot_1: mine.filter((i) => i.impact === 'BLOCKS_PILOT_1').sort(order).map((i) => i.id),
      quality_of_life: mine.filter((i) => i.impact === 'QUALITY_OF_LIFE').sort(order).map((i) => i.id),
      slipped: mine.filter((i) => i.date_state === 'slipped').length,
      date_to_set: mine.filter((i) => i.date_state === 'date_to_set').length,
    };
  });
}

export async function read(now = new Date()) {
  const today = now.toISOString().slice(0, 10);
  const [g, rows] = await Promise.all([gates(today), items()]);
  const resolved = await resolve(rows, now);
  const verdict = decide(g.list, resolved);
  let cst: Awaited<ReturnType<typeof cstSummary>> | null = null;
  let cstError: string | null = null;
  try {
    cst = await cstSummary();
  } catch (e) {
    cstError = (e as Error).message;
  }
  const blocking = [...g.list, ...resolved.filter((i) => i.impact === 'BLOCKS_PILOT_1')].filter((b) => b.open);
  const gate = (id: string) => !(g.list.find((x) => x.id === id)?.open ?? true);
  return {
    board_key: BOARD_KEY,
    question: QUESTION,
    ready: verdict.ready ? 'Yes' : 'No',
    why: verdict.why,
    fields: { Ready_for_first_paid_pilot: verdict.ready ? 'Yes' : 'No', STAGE1_PASSED: gate('STAGE1_PASSED'), CHARGE_GATE_OPEN: gate('CHARGE_GATE_OPEN') },
    blocking,
    gates: g.list,
    items: resolved,
    items_closed: resolved.filter((i) => !i.open).length,
    sections: bySection(resolved),
    owner_views: ownerViews([...g.list, ...resolved]),
    this_week: {
      since: new Date(now.getTime() - WEEK_DAYS * 86_400_000).toISOString().slice(0, 10),
      moved: resolved.filter((i) => i.moved_this_week).map((i) => ({ id: i.id, title: i.title, owner: i.owner, status: i.status, last_change: i.last_change, link: i.link })),
      slipped: resolved.filter((i) => i.date_state === 'slipped').map((i) => ({ id: i.id, title: i.title, owner: i.owner, target_date: i.target_date, days_slipped: i.days_slipped, link: i.link })),
      date_to_set: resolved.filter((i) => i.date_state === 'date_to_set').length,
      stalled_cst_loops: cst ? cst.stalled : null,
      rule: `Moved: the loop was written, or the watch opened or closed, in the last ${WEEK_DAYS} days. Slipped: open past its target date. A loop's date is its board date, else its own Due Date.`,
    },
    cst,
    read_errors: [...g.errors, ...(cstError ? [`CST summary: ${cstError}`] : [])],
    rule: 'Ready is Yes only when STAGE1_PASSED (a real passed Stage 1 record for both H9KF and L4WA) and CHARGE_GATE_OPEN (Jason\'s offer_approved and Hardik\'s pass recorded, and one live end-to-end payment above the $1 team tests) are both true, read from the records and never set by hand, and every item marked BLOCKS_PILOT_1 is closed. QUALITY_OF_LIFE items never hold it at No. An item with no label counts as blocking; an item that cannot be read counts as open.',
    page: PAGE,
    read_at: now.toISOString(),
  };
}

/* ------------------------------------------------------------------ writes */

export interface SetInput {
  action: 'add' | 'remove' | 'update';
  record_id: string;
  reason?: string | null;
  target_date?: string | null;
  section?: string | null;
  impact?: string | null;
  /** Gates only: the Slack id of who owns it. */
  owner?: string | null;
  requester: string | null;
}

const LOOP_RE = /^LOOP-\d{10,}-[A-Z0-9]{4}$/;
const WATCH_RE = /^DW-\d{10,}-[A-Z0-9]{4}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Checks section, impact and target_date as sent; undefined leaves a field alone. Pure. */
export function checkFields(i: Pick<SetInput, 'section' | 'impact' | 'target_date'>): { ok: true; set: Record<string, string | null> } | { ok: false; reason: string; message: string } {
  const set: Record<string, string | null> = {};
  if (i.section !== undefined) {
    const v = (i.section ?? '').trim() || null;
    if (v && !SECTION_KEYS.includes(v)) return { ok: false, reason: 'bad_section', message: `section is one of ${SECTION_KEYS.join(', ')}.` };
    set.section = v;
  }
  if (i.impact !== undefined) {
    const v = (i.impact ?? '').trim() || null;
    if (v && !(IMPACTS as readonly string[]).includes(v)) return { ok: false, reason: 'bad_impact', message: 'impact is BLOCKS_PILOT_1 or QUALITY_OF_LIFE.' };
    set.impact = v;
  }
  if (i.target_date !== undefined) {
    const v = (i.target_date ?? '').trim() || null;
    if (v && !DATE_RE.test(v)) return { ok: false, reason: 'bad_target_date', message: 'target_date is YYYY-MM-DD, or empty for date_to_set.' };
    set.target_date = v;
  }
  return { ok: true, set };
}

const SLACK_ID_RE = /^[UW][A-Z0-9]{6,}$/;

/**
 * A gate's owner and date (26 Nov 2026). Only update, only Destiny or Jason, a reason always. Whether the gate is true
 * is never set here: that is read from the records. Each change is a new row, so a moved date keeps the old one and
 * its reason on record.
 */
async function setGate(i: SetInput & { reason: string }, dryRun: boolean): Promise<Record<string, unknown>> {
  if (i.action !== 'update') return { ok: false, reason: 'gate_update_only', message: `${i.record_id} is always on the board; only its owner and target_date can be changed (action update).` };
  if (i.reason.length < 3) return { ok: false, reason: 'reason_required', message: 'Say why: who owns this gate and why that date.' };
  const owner = i.owner === undefined ? undefined : (i.owner ?? '').trim() || null;
  if (owner && !SLACK_ID_RE.test(owner)) return { ok: false, reason: 'bad_owner', message: 'owner is a Slack user id (U...).' };
  const f = checkFields({ target_date: i.target_date });
  if (!f.ok) return f;
  if (owner === undefined && i.target_date === undefined) return { ok: false, reason: 'nothing_to_change', message: 'Send owner, target_date or both.' };
  const before = (await gateSets())[i.record_id] ?? null;
  const next = { owner: owner === undefined ? before?.owner ?? null : owner, target_date: i.target_date === undefined ? before?.target_date ?? null : (f.set.target_date ?? null) };
  if (dryRun) return { ok: true, dry_run: true, would: `set ${i.record_id}`, before, after: next };
  await query(
    `INSERT INTO engine_income_board_gate_sets (board_key, gate_id, owner, target_date, set_by, reason) VALUES ($1, $2, $3, $4::date, $5, $6)`,
    [BOARD_KEY, i.record_id, next.owner, next.target_date, i.requester, i.reason.slice(0, 600)],
  );
  return { ok: true, updated: i.record_id, before, after: next, reason: i.reason, page: PAGE };
}

/** Adds, updates or removes one item. Only Destiny or Jason. Nothing is deleted: a removal is dated and signed. */
export async function setItem(i: SetInput, dryRun = false): Promise<Record<string, unknown>> {
  if (!i.requester || !ADMIN_IDS.includes(i.requester)) return { ok: false, reason: 'not_permitted', message: 'Only Destiny (U0AEW3TBYH1) or Jason (U0A9V97949F) changes what is on the Production-Income Board.' };
  const id = (i.record_id ?? '').trim();
  const reason = (i.reason ?? '').trim();
  if ((GATE_IDS as readonly string[]).includes(id)) return setGate({ ...i, record_id: id, reason }, dryRun);
  const kind = LOOP_RE.test(id) ? 'loop' : WATCH_RE.test(id) ? 'watch' : null;
  if (!kind) return { ok: false, reason: 'bad_record_id', message: 'record_id is a full loop id (LOOP-...), a Decision Watch id (DW-...), or a gate (STAGE1_PASSED, CHARGE_GATE_OPEN).' };
  if (reason.length < 3) return { ok: false, reason: 'reason_required', message: 'Say why, in a few words: what it blocks, what changed, or why it comes off.' };
  const f = checkFields(i);
  if (!f.ok) return f;
  const held = (await query(`SELECT 1 FROM engine_income_board_items WHERE board_key = $1 AND record_id = $2 AND removed_at IS NULL`, [BOARD_KEY, id])).rowCount;
  if (i.action === 'add') {
    const exists = kind === 'loop'
      ? (await query(`SELECT 1 FROM engine_loops WHERE natural_id = $1 LIMIT 1`, [id])).rowCount
      : (await query(`SELECT 1 FROM engine_decision_watches WHERE watch_id = $1 LIMIT 1`, [id])).rowCount;
    if (!exists) return { ok: false, reason: 'not_held', message: `${id} is not held on the dashboard.` };
    if (held) return { ok: false, reason: 'already_on_board', message: `${id} is already on the board; use update to change its section, impact or date.` };
    if (dryRun) return { ok: true, dry_run: true, would: `add ${kind} ${id}`, ...f.set };
    await query(
      `INSERT INTO engine_income_board_items (board_key, kind, record_id, reason, target_date, section, impact, added_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [BOARD_KEY, kind, id, reason.slice(0, 600), f.set.target_date ?? null, f.set.section ?? null, f.set.impact ?? null, i.requester],
    );
    return { ok: true, added: id, kind, ...f.set, page: PAGE };
  }
  if (!held) return { ok: false, reason: 'not_on_board', message: `${id} is not on the board.` };
  if (i.action === 'update') {
    const keys = Object.keys(f.set);
    if (!keys.length) return { ok: false, reason: 'nothing_to_change', message: 'Send section, impact or target_date to change.' };
    if (dryRun) return { ok: true, dry_run: true, would: `update ${id}`, ...f.set };
    const before = (await query<Record<string, string | null>>(`SELECT section, impact, target_date::text FROM engine_income_board_items WHERE board_key = $1 AND record_id = $2 AND removed_at IS NULL`, [BOARD_KEY, id])).rows[0];
    const cols = keys.map((k, n) => `${k} = $${n + 3}${k === 'target_date' ? '::date' : ''}`).join(', ');
    await query(`UPDATE engine_income_board_items SET ${cols} WHERE board_key = $1 AND record_id = $2 AND removed_at IS NULL`, [BOARD_KEY, id, ...keys.map((k) => f.set[k])]);
    return { ok: true, updated: id, before, after: f.set, reason, page: PAGE };
  }
  if (dryRun) return { ok: true, dry_run: true, would: `remove ${id}` };
  await query(`UPDATE engine_income_board_items SET removed_at = now(), removed_by = $3, removed_reason = $4 WHERE board_key = $1 AND record_id = $2 AND removed_at IS NULL`, [BOARD_KEY, id, i.requester, reason.slice(0, 600)]);
  return { ok: true, removed: id, page: PAGE };
}

/**
 * The blockers page (23 Nov 2026, Destiny: "any loop that is blocked: what is blocking it, the date it will be
 * unblocked, the lane, a tag, why, and who it is assigned to"). A loop is on it while it is Open or In Progress and
 * carries a "Blocked By" field. Four new fields on the loop, set with update_record (nothing renamed):
 *   "Blocked By"   what is in the way
 *   "Unblock Date" YYYY-MM-DD, the date it will be unblocked (late once past and still blocked)
 *   "Blocked Tag"  the part inside the lane, e.g. rover under VFARM_HARDWARE
 *   "Blocked Why"  why it is blocked, and whether it stops the paid pilot
 * The lane is the loop's own lane_tag and the owner its assignee. Clearing "Blocked By" (null) takes it off.
 */
export interface BlockedLoop {
  loop_id: string;
  title: string;
  status: string;
  blocked_by: string;
  unblock_date: string | null;
  late: boolean;
  days_late: number | null;
  lane: string | null;
  tag: string | null;
  why: string | null;
  owner: string | null;
  link: string;
}

/** Late when the unblock date has passed. Pure. */
export function lateness(unblockDate: string | null, today: string): { late: boolean; days_late: number | null } {
  if (!unblockDate || !/^\d{4}-\d{2}-\d{2}$/.test(unblockDate)) return { late: false, days_late: null };
  const d = Math.floor((Date.parse(today) - Date.parse(unblockDate)) / 86_400_000);
  return d > 0 ? { late: true, days_late: d } : { late: false, days_late: null };
}

export async function blockers(now = new Date()): Promise<{ rows: BlockedLoop[]; late: number; no_date: number; read_at: string; rule: string }> {
  const today = now.toISOString().slice(0, 10);
  const r = await query<{ natural_id: string; fields: Record<string, unknown> }>(
    `SELECT DISTINCT ON (natural_id) natural_id, fields FROM engine_loops
      WHERE natural_id IS NOT NULL ORDER BY natural_id, id DESC`,
  );
  const s = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const rows: BlockedLoop[] = [];
  for (const row of r.rows) {
    const f = row.fields || {};
    const status = s(f.Status) ?? '';
    const by = s(f['Blocked By']);
    if (!by || !OPEN_LOOP.has(status)) continue;
    const date = s(f['Unblock Date']);
    rows.push({
      loop_id: row.natural_id,
      title: s(f.What) ?? '',
      status,
      blocked_by: by,
      unblock_date: date,
      ...lateness(date, today),
      lane: s(f.lane_tag),
      tag: s(f['Blocked Tag']),
      why: s(f['Blocked Why']),
      owner: nameOf(s(f['Assignee Slack User ID'])),
      link: `${LOOP_PAGE}${row.natural_id}`,
    });
  }
  rows.sort((a, b) => Number(b.late) - Number(a.late) || (a.unblock_date ?? '9999').localeCompare(b.unblock_date ?? '9999') || a.loop_id.localeCompare(b.loop_id));
  return {
    rows,
    late: rows.filter((x) => x.late).length,
    no_date: rows.filter((x) => !x.unblock_date).length,
    read_at: now.toISOString(),
    rule: 'A loop is here while it is open and has "Blocked By" set. Late means its unblock date has passed and it is still blocked.',
  };
}

/**
 * The short form of the blockers list for agents (23 Nov 2026: 97 blocked loops made read_income_board about 229,000
 * characters and Genie's read was cut to 1,000). The counts over every row, then the 25 that matter most: late first,
 * then those that stop the paid pilot, then the rest by unblock date. Pure.
 */
export const SHORT_BLOCKERS = 25;
export function shortBlockers(b: Awaited<ReturnType<typeof blockers>>) {
  const pilot = (x: BlockedLoop) => /stops the paid pilot/i.test(x.why ?? '');
  const by_owner: Record<string, number> = {};
  for (const x of b.rows) by_owner[x.owner ?? 'none'] = (by_owner[x.owner ?? 'none'] ?? 0) + 1;
  const ranked = [...b.rows].sort((a, c) => Number(c.late) - Number(a.late) || Number(pilot(c)) - Number(pilot(a)) || (a.unblock_date ?? '9999').localeCompare(c.unblock_date ?? '9999'));
  const cut = (v: string | null, n: number) => (v && v.length > n ? `${v.slice(0, n)}…` : v);
  return {
    total: b.rows.length,
    late: b.late,
    no_date: b.no_date,
    stops_paid_pilot: b.rows.filter(pilot).length,
    by_owner,
    shown: Math.min(SHORT_BLOCKERS, b.rows.length),
    rows: ranked.slice(0, SHORT_BLOCKERS).map((x) => ({ ...x, title: cut(x.title, 160) ?? '', blocked_by: cut(x.blocked_by, 200) ?? '', why: cut(x.why, 200) })),
    complete: b.rows.length <= SHORT_BLOCKERS,
    note: b.rows.length > SHORT_BLOCKERS
      ? `Summary by design, not a cut read: all ${b.rows.length} blocked loops are counted above (late, no date, stops the paid pilot, by_owner), and the ${SHORT_BLOCKERS} that matter most are listed. Say "${SHORT_BLOCKERS} of ${b.rows.length} shown", never that the read was cut or incomplete. The evening report and the Monday and Friday blocker tags are built on the dashboard from the full list, so they never depend on this read. For one person's blocked loops in full pass blocked_owner; for every one pass full: true.`
      : 'Every blocked loop.',
    rule: b.rule,
    read_at: b.read_at,
  };
}

/**
 * One person's blocked loops in full (26 Nov 2026, Destiny: Genie read the short list as a cut read). Matches the
 * owner's name case-blind, or a Slack id through the roster. Pure.
 */
export function ownerBlockers(b: Awaited<ReturnType<typeof blockers>>, who: string) {
  const w = who.trim();
  const name = /^[UW][A-Z0-9]{6,}$/.test(w) ? nameOf(w) : w;
  const key = (name ?? w).toLowerCase();
  const rows = b.rows.filter((x) => (x.owner ?? '').toLowerCase() === key || (x.owner ?? '').toLowerCase().split(/\s+/)[0] === key);
  return {
    owner: name ?? w,
    total: rows.length,
    late: rows.filter((x) => x.late).length,
    no_date: rows.filter((x) => !x.unblock_date).length,
    complete: true,
    rows,
    note: rows.length ? `Every blocked loop owned by ${name ?? w}.` : `No blocked loop is owned by ${name ?? w}. Owners held: ${[...new Set(b.rows.map((x) => x.owner ?? 'none'))].join(', ')}.`,
    rule: b.rule,
    read_at: b.read_at,
  };
}

/**
 * Set or clear a loop's blocked fields from the page (23 Nov 2026, Destiny). Writes into the loop's latest row
 * through engineWrite.patchRecord, the same merge every loop update uses, so nothing else on the loop changes.
 * `clear` removes all four fields, which takes the loop off the page.
 */
export class BlockedError extends Error {
  constructor(public status: number, public reason: string, message: string) {
    super(message);
  }
}

export async function setBlocked(
  loopId: string,
  body: { blocked_by?: unknown; unblock_date?: unknown; tag?: unknown; why?: unknown; clear?: unknown },
): Promise<{ ok: true; loop_id: string; cleared: boolean }> {
  const { patchRecord } = await import('./engineWrite');
  const id = loopId.trim();
  if (!/^LOOP-\d+-[A-Z0-9]{4}$/.test(id)) throw new BlockedError(422, 'bad_loop_id', `"${id}" is not a loop id (LOOP-<ms>-<4>).`);
  const row = (await query<{ id: string; status: string | null }>(
    `SELECT id::text AS id, fields->>'Status' AS status FROM engine_loops WHERE natural_id = $1 ORDER BY id DESC LIMIT 1`,
    [id],
  )).rows[0];
  if (!row) throw new BlockedError(404, 'not_found', `No loop ${id} is held.`);
  const text = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
  let fields: Record<string, unknown>;
  if (body.clear === true) {
    fields = { 'Blocked By': null, 'Unblock Date': null, 'Blocked Tag': null, 'Blocked Why': null };
  } else {
    const by = text(body.blocked_by, 600);
    if (!by) throw new BlockedError(422, 'blocked_by_required', 'Say what is blocking it. To take a loop off the page, clear it instead.');
    const date = text(body.unblock_date, 10);
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new BlockedError(422, 'bad_date', 'The unblock date must be YYYY-MM-DD, or left empty.');
    if (!OPEN_LOOP.has(row.status ?? '')) throw new BlockedError(409, 'not_open', `${id} is ${row.status ?? 'not open'}; only an open loop can be marked blocked.`);
    fields = { 'Blocked By': by, 'Unblock Date': date, 'Blocked Tag': text(body.tag, 80), 'Blocked Why': text(body.why, 600) };
  }
  await patchRecord('loops', row.id, fields, { endpoint: '/api/income-board/blockers', method: 'POST', key_label: 'session cookie', t0: Date.now() }, id);
  return { ok: true, loop_id: id, cleared: body.clear === true };
}
