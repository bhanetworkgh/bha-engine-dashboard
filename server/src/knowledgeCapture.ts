/**
 * Knowledge capture on the Production-Income Board (23 Nov 2026, Destiny; D4 of that day's session). What only one
 * person knows, that the paid pilot needs written down: Hardik's CAD, Golden Lane and subscription backend, Ahad's
 * CST, vFarm identity and database, Jegan's rack, BHARAG and AWS, and Destiny's engine.
 *
 * One row per piece of knowledge (engine_knowledge_capture, migration 150): who holds it now, where it lives (repos,
 * files, Codex entries, watches, loops, documents), its mark, who picks it up, the handover date and its status.
 *   - mark: KNOWLEDGE_CAPTURE_REQUIRED (someone else has to be able to run it without the holder) or BLOCKS_PILOT_1
 *     (Shibu's paid pilot cannot happen without it).
 *   - status: not_started, in_progress, captured. **Captured needs proof**: an EV- document held on the dashboard
 *     and not a test, a BHARAG SOP id, or an https link to the written handover. Nothing is captured on a say-so.
 *   - to_confirm: a row drafted from the records and not yet confirmed by its holder says so, and with whom.
 * Destiny or Jason write rows (page or set_knowledge_capture); every change is one knowledge_capture_changed event
 * with the fields before and after. Nothing is deleted: a row taken off is dated and signed.
 */
import { query } from './pg';
import { ADMIN_IDS } from './writeGuards';
import * as engineEvents from './engineEvents';

export const MARKS = ['KNOWLEDGE_CAPTURE_REQUIRED', 'BLOCKS_PILOT_1'] as const;
export const STATUSES = ['not_started', 'in_progress', 'captured'] as const;
export const REF_KINDS = ['repo', 'file', 'codex', 'watch', 'loop', 'doc', 'sop', 'evidence', 'service', 'other'] as const;
export type Mark = (typeof MARKS)[number];
export type Status = (typeof STATUSES)[number];

const BASE = (process.env.PUBLIC_DASHBOARD_URL || 'https://dashboard.bhanetwork.org').replace(/\/+$/, '');
const NAMES: Record<string, string> = { U0A9V97949F: 'Jason', U0AEW3TBYH1: 'Destiny', U0AF011R821: 'Jegan', U0BKT6MAW2Y: 'Hardik', U0AC6RFNP3P: 'Ahad', U0BNQGG020Y: 'Kavin' };
const nameOf = (id: string | null) => (id ? NAMES[id] ?? id : null);

export interface Ref { kind: string; ref: string; url?: string | null }
export interface KnowledgeRow {
  item_id: string;
  holder: string;
  holder_name: string | null;
  area: string;
  piece: string;
  lives_in: Ref[];
  mark: Mark;
  picked_up_by: string | null;
  picked_up_by_name: string | null;
  handover_date: string | null;
  status: Status;
  proof_ref: string | null;
  to_confirm: string | null;
  notes: string | null;
  late: boolean;
  updated_at: string;
}

/** A link for a reference, where one can be worked out from its id. Pure. */
export function refUrl(r: Ref): string | null {
  if (r.url && /^https:\/\//.test(r.url)) return r.url;
  const v = r.ref.trim();
  if (/^LOOP-\d+-[A-Z0-9]{4}$/.test(v)) return `${BASE}/open-loops/${v}`;
  if (/^CODEX-/.test(v)) return `${BASE}/codex/${v}`;
  if (/^EV-\d+-[A-Z0-9]{4}$/.test(v)) return `${BASE}/evidence?id=${v}`;
  if (r.kind === 'repo' && /^[\w.-]+\/[\w.-]+$/.test(v)) return `https://github.com/${v}`;
  return null;
}

/** What makes a row captured. Pure: returns the reason it is not acceptable, or null. */
export function proofProblem(proof: string | null): string | null {
  const p = (proof ?? '').trim();
  if (!p) return 'A row is captured only with proof: an EV- document, a BHARAG SOP id, or an https link to the written handover.';
  if (/^EV-\d+-[A-Z0-9]{4}$/.test(p) || /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(p) || /^https:\/\/\S+$/.test(p)) return null;
  return `"${p}" is not proof: give an EV- id, a BHARAG SOP id or an https link.`;
}

function toRow(r: Record<string, unknown>, today: string): KnowledgeRow {
  const date = dateOnly(r.handover_date);
  const status = r.status as Status;
  const lives = Array.isArray(r.lives_in) ? (r.lives_in as Ref[]).map((x) => ({ kind: x.kind, ref: x.ref, url: refUrl(x) })) : [];
  return {
    item_id: String(r.item_id),
    holder: String(r.holder),
    holder_name: nameOf(String(r.holder)),
    area: String(r.area),
    piece: String(r.piece),
    lives_in: lives,
    mark: r.mark as Mark,
    picked_up_by: (r.picked_up_by as string) ?? null,
    picked_up_by_name: nameOf((r.picked_up_by as string) ?? null),
    handover_date: date,
    status,
    proof_ref: (r.proof_ref as string) ?? null,
    to_confirm: (r.to_confirm as string) ?? null,
    notes: (r.notes as string) ?? null,
    late: !!date && status !== 'captured' && date < today,
    updated_at: new Date(String(r.updated_at)).toISOString(),
  };
}

export async function read(now = new Date()) {
  const today = now.toISOString().slice(0, 10);
  const r = await query<Record<string, unknown>>(
    `SELECT * FROM engine_knowledge_capture WHERE removed_at IS NULL ORDER BY (mark = 'BLOCKS_PILOT_1') DESC, holder, area, item_id`,
  );
  const rows = r.rows.map((x) => toRow(x, today));
  const by = (k: (x: KnowledgeRow) => string) => rows.reduce<Record<string, number>>((m, x) => ((m[k(x)] = (m[k(x)] ?? 0) + 1), m), {});
  return {
    rows,
    total: rows.length,
    blocks_pilot: rows.filter((x) => x.mark === 'BLOCKS_PILOT_1').length,
    captured: rows.filter((x) => x.status === 'captured').length,
    no_pickup: rows.filter((x) => !x.picked_up_by).length,
    no_date: rows.filter((x) => !x.handover_date).length,
    late: rows.filter((x) => x.late).length,
    to_confirm: rows.filter((x) => x.to_confirm).length,
    by_holder: by((x) => x.holder_name ?? x.holder),
    by_status: by((x) => x.status),
    rule: 'One row per piece of knowledge only one person holds. BLOCKS_PILOT_1: the paid pilot cannot happen without it; KNOWLEDGE_CAPTURE_REQUIRED: someone else has to be able to run it. Captured only with proof (an EV- document, a BHARAG SOP id or an https link). A row drafted from the records and not yet confirmed by its holder says who to confirm with.',
    read_at: now.toISOString(),
  };
}

/* ------------------------------------------------------------------ writes */

export class KnowledgeError extends Error {
  constructor(public status: number, public reason: string, message: string) {
    super(message);
  }
}

export interface KnowledgeInput {
  item_id?: unknown;
  holder?: unknown;
  area?: unknown;
  piece?: unknown;
  lives_in?: unknown;
  mark?: unknown;
  picked_up_by?: unknown;
  handover_date?: unknown;
  status?: unknown;
  proof_ref?: unknown;
  to_confirm?: unknown;
  notes?: unknown;
  remove?: unknown;
  reason?: unknown;
}

const text = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const SLACK_ID = /^[UW][A-Z0-9]{8,}$/;

/** A stored date as YYYY-MM-DD. pg hands a date column back as a Date at local midnight, and String() of that is
 *  "Sun Dec 13 2026 …", which failed this file's own date check on every later edit of a dated row (24 Nov 2026). */
export function dateOnly(v: unknown): string | null {
  if (!v) return null;
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return null;
    const p = (n: number) => String(n).padStart(2, '0');
    return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`;
  }
  return String(v).slice(0, 10);
}

/** Checks and normalises one write. Pure apart from nothing: callers fetch `before`. */
export function normalise(i: KnowledgeInput, before: Record<string, unknown> | null): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const has = (k: keyof KnowledgeInput) => i[k] !== undefined;
  const pick = (k: keyof KnowledgeInput, max: number) => (has(k) ? text(i[k], max) : (before?.[k as string] as string) ?? null);
  out.holder = pick('holder', 20);
  out.area = pick('area', 120);
  out.piece = pick('piece', 1200);
  out.mark = pick('mark', 40);
  out.picked_up_by = pick('picked_up_by', 20);
  out.status = pick('status', 20) ?? 'not_started';
  out.proof_ref = pick('proof_ref', 400);
  out.to_confirm = pick('to_confirm', 300);
  out.notes = pick('notes', 1200);
  const date = has('handover_date') ? text(i.handover_date, 10) : dateOnly(before?.handover_date);
  out.handover_date = date;
  let lives: Ref[] = Array.isArray(before?.lives_in) ? (before!.lives_in as Ref[]) : [];
  if (has('lives_in')) {
    if (!Array.isArray(i.lives_in)) throw new KnowledgeError(422, 'bad_lives_in', 'lives_in is a list of {kind, ref, url?}.');
    lives = [];
    for (const x of i.lives_in as unknown[]) {
      const o = x as Record<string, unknown>;
      const kind = text(o?.kind, 20);
      const ref = text(o?.ref, 300);
      if (!kind || !(REF_KINDS as readonly string[]).includes(kind) || !ref) throw new KnowledgeError(422, 'bad_lives_in', `Each place is {kind, ref}, kind one of ${REF_KINDS.join(', ')}.`);
      const url = text(o?.url, 500);
      lives.push(url ? { kind, ref, url } : { kind, ref });
    }
  }
  out.lives_in = lives;
  if (!out.holder || !SLACK_ID.test(String(out.holder))) throw new KnowledgeError(422, 'bad_holder', 'holder is the Slack id of the person who holds the knowledge.');
  if (out.picked_up_by && !SLACK_ID.test(String(out.picked_up_by))) throw new KnowledgeError(422, 'bad_picked_up_by', 'picked_up_by is a Slack id, or left empty.');
  if (!out.area || !out.piece) throw new KnowledgeError(422, 'area_and_piece_required', 'Say the area (e.g. CAD) and the piece of knowledge.');
  if (!(MARKS as readonly string[]).includes(String(out.mark))) throw new KnowledgeError(422, 'bad_mark', `mark is ${MARKS.join(' or ')}.`);
  if (!(STATUSES as readonly string[]).includes(String(out.status))) throw new KnowledgeError(422, 'bad_status', `status is ${STATUSES.join(', ')}.`);
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new KnowledgeError(422, 'bad_date', 'handover_date is YYYY-MM-DD, or left empty.');
  if (out.status === 'captured') {
    const p = proofProblem(out.proof_ref as string | null);
    if (p) throw new KnowledgeError(422, 'proof_required', p);
  }
  return out;
}

function newId(area: string): string {
  const slug = area.toUpperCase().replace(/[^A-Z0-9]+/g, '').slice(0, 6) || 'KC';
  return `KC-${slug}-${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 4).toUpperCase()}`;
}

/** Create, update or take off one row. Destiny or Jason only. */
export async function setItem(i: KnowledgeInput, requester: string | null, dryRun = false): Promise<Record<string, unknown>> {
  if (!requester || !ADMIN_IDS.includes(requester)) throw new KnowledgeError(403, 'not_permitted', 'Only Destiny (U0AEW3TBYH1) or Jason (U0A9V97949F) changes the knowledge capture rows.');
  const id = text(i.item_id, 60);
  const before = id ? ((await query<Record<string, unknown>>(`SELECT * FROM engine_knowledge_capture WHERE item_id = $1`, [id])).rows[0] ?? null) : null;
  if (id && !before) throw new KnowledgeError(404, 'not_found', `No knowledge capture row ${id}.`);
  if (before?.removed_at) throw new KnowledgeError(409, 'removed', `${id} was taken off the board.`);
  if (i.remove === true) {
    if (!before) throw new KnowledgeError(422, 'item_id_required', 'Name the row to take off.');
    const reason = text(i.reason, 600);
    if (!reason || reason.length < 3) throw new KnowledgeError(422, 'reason_required', 'Say why it comes off.');
    if (dryRun) return { ok: true, dry_run: true, would: `take off ${id}` };
    await query(`UPDATE engine_knowledge_capture SET removed_at = now(), removed_by = $2, removed_reason = $3 WHERE item_id = $1`, [id, requester, reason]);
    await engineEvents.record({ event_type: 'knowledge_capture_changed', subject_id: id!, lane: null, actor: requester, detail: { action: 'removed', reason, before } });
    return { ok: true, removed: id };
  }
  const v = normalise(i, before);
  const p = typeof v.proof_ref === 'string' && /^EV-/.test(v.proof_ref) ? v.proof_ref : null;
  if (p && v.status === 'captured') {
    const ev = (await query<{ test: boolean }>(`SELECT coalesce(test, false) AS test FROM engine_evidence WHERE evidence_id = $1 LIMIT 1`, [p]).catch(() => ({ rows: [] as { test: boolean }[] }))).rows[0];
    if (!ev) throw new KnowledgeError(422, 'proof_not_found', `${p} is not held in the evidence store.`);
    if (ev.test) throw new KnowledgeError(422, 'proof_is_test', `${p} is a test document.`);
  }
  const item = id ?? newId(String(v.area));
  if (dryRun) return { ok: true, dry_run: true, would: before ? `update ${item}` : `create ${item}`, row: { item_id: item, ...v } };
  await query(
    `INSERT INTO engine_knowledge_capture (item_id, holder, area, piece, lives_in, mark, picked_up_by, handover_date, status, proof_ref, to_confirm, notes, added_by, updated_by)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11,$12,$13,$13)
     ON CONFLICT (item_id) DO UPDATE SET holder = EXCLUDED.holder, area = EXCLUDED.area, piece = EXCLUDED.piece, lives_in = EXCLUDED.lives_in,
       mark = EXCLUDED.mark, picked_up_by = EXCLUDED.picked_up_by, handover_date = EXCLUDED.handover_date, status = EXCLUDED.status,
       proof_ref = EXCLUDED.proof_ref, to_confirm = EXCLUDED.to_confirm, notes = EXCLUDED.notes, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [item, v.holder, v.area, v.piece, JSON.stringify(v.lives_in), v.mark, v.picked_up_by, v.handover_date, v.status, v.proof_ref, v.to_confirm, v.notes, requester],
  );
  await engineEvents.record({ event_type: 'knowledge_capture_changed', subject_id: item, lane: null, actor: requester, detail: { action: before ? 'updated' : 'created', before, after: v } });
  return { ok: true, item_id: item, created: !before };
}
