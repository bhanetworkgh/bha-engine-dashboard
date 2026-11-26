/**
 * Decision Watch closure classification (26 Nov 2026, Destiny — Jason in C0ASMPYQLG3 1795642017.292079;
 * SOP 81cd9c04-98fa-4f75-94a9-fed445fcce4e, "Decision Watch closure standard").
 *
 * The SOP allows a watch exactly one of three states:
 *   closed_with_proof   the close names a concrete reference (a link, LOOP-/TASK-/DW-/CODEX-/EV-/INC- id,
 *                       a commit, an SOP id, a run, audit or event id), or a "moved" close on its linked record;
 *   superseded          the close points to the DW- it was folded into (another watch, never itself);
 *   open                still watching, nothing claimed.
 * Anything else breaks the SOP and is named: closed_without_proof (answered or cancelled with no reference),
 * escalated (the reminders ran out and nobody closed or superseded it). An open watch is also flagged stale when
 * the record shows it is likely done or abandoned: its linked loop or task is closed, its owner has left BHA,
 * or nothing has moved on it for STALE_QUIET_DAYS.
 *
 * `classify` is pure; `classifyAll` reads every watch (decisionWatch.read) and the linked loops once.
 */
import * as dw from './decisionWatch';
import { query } from './pg';
import { isFormerBuilder } from './sources';

export const STATES = ['closed_with_proof', 'superseded', 'open', 'closed_without_proof', 'escalated'] as const;
export type WatchState = (typeof STATES)[number];
export const COMPLIANT: readonly WatchState[] = ['closed_with_proof', 'superseded', 'open'];
export const STALE_QUIET_DAYS = 14;

type Watch = ReturnType<typeof dw.show>;

const REF_RES: RegExp[] = [
  /https?:\/\/\S+/gi,
  /\b(?:LOOP|TASK|CODEX|EV|INC|MTP|IC|APR|BP|CAND)-[A-Z0-9][A-Z0-9.\-]*\d[A-Z0-9.\-]*/gi,
  /\bDW-\d{10,}-[A-Z0-9]{4}\b/gi,
  /\b(?:SOP|audit|audits|event|events|run|execution|commit|PR|dep)[ #:]*[a-f0-9-]{3,}\b/gi,
  /(?<![\w-])(?=[0-9a-f]*[a-f])(?=[0-9a-f]*\d)[0-9a-f]{7,40}(?![\w-])/g,
];

/** Every concrete reference a close reason carries, in order, de-duplicated. Pure. */
export function refsIn(text: string | null | undefined): string[] {
  if (!text) return [];
  const out: string[] = [];
  for (const re of REF_RES) for (const m of text.match(re) ?? []) {
    const v = m.replace(/[),.;]+$/, '');
    // A ref inside one already found (an id inside a link) is the same reference.
    if (!out.some((o) => o.includes(v))) out.push(v);
  }
  return out;
}

export interface Classified {
  watch_id: string;
  owner_user_id: string;
  owner_name: string | null;
  status: string;
  state: WatchState;
  compliant: boolean;
  proof: string[];
  successor: string | null;
  stale: string[];
  decision: string;
  thread_link: string | null;
  closed_at: string | null;
  quiet_days: number | null;
}

/** One watch's state under the SOP. `recordClosed` says whether its linked loop or task is closed. Pure. */
export function classify(w: Watch, recordClosed: boolean | null, now = new Date()): Classified {
  const reason = w.close_reason ?? '';
  const refs = refsIn(reason).filter((r) => r !== w.watch_id);
  const successor = refs.find((r) => /^DW-/i.test(r)) ?? null;
  let state: WatchState;
  let proof: string[] = [];
  if (w.status === 'watching') state = 'open';
  else if (w.status === 'escalated') state = 'escalated';
  else if (w.status === 'moved') {
    state = 'closed_with_proof';
    proof = w.record ? [w.record.id as string] : refs;
  } else if (w.status === 'cancelled' && successor && /fold|supersed|replac|merged|duplicate|same ask/i.test(reason)) {
    state = 'superseded';
  } else if (refs.length) {
    state = 'closed_with_proof';
    proof = refs;
  } else state = 'closed_without_proof';

  const stale: string[] = [];
  const quietMs = w.quiet_since ? now.getTime() - new Date(w.quiet_since).getTime() : null;
  const quietDays = quietMs == null ? null : Math.floor(quietMs / 86_400_000);
  if (state === 'open') {
    if (recordClosed) stale.push(`its linked ${w.record?.kind === 'loops' ? 'loop' : 'task'} ${w.record?.id} is closed`);
    if (isFormerBuilder(w.owner_user_id)) stale.push('its owner has left BHA');
    if (quietDays != null && quietDays >= STALE_QUIET_DAYS && !w.snoozed_until) stale.push(`nothing has moved on it for ${quietDays} days`);
  }
  return {
    watch_id: w.watch_id,
    owner_user_id: w.owner_user_id,
    owner_name: w.owner_name,
    status: w.status,
    state,
    compliant: COMPLIANT.includes(state),
    proof,
    successor: state === 'superseded' ? successor : null,
    stale,
    decision: w.decision.length > 160 ? `${w.decision.slice(0, 159)}…` : w.decision,
    thread_link: w.thread_link,
    closed_at: w.closed_at,
    quiet_days: state === 'open' ? quietDays : null,
  };
}

const zero = () => Object.fromEntries(STATES.map((s) => [s, 0])) as Record<WatchState, number>;

/** Counts per state, the stale count and whether the owner meets the SOP. Pure. */
export function summarise(rows: Classified[]) {
  const byOwner = new Map<string, { owner_user_id: string; owner_name: string | null; total: number; counts: Record<WatchState, number>; stale_open: number; breaking_sop: number }>();
  const counts = zero();
  let staleOpen = 0;
  for (const r of rows) {
    counts[r.state]++;
    if (r.stale.length) staleOpen++;
    const o = byOwner.get(r.owner_user_id) ?? { owner_user_id: r.owner_user_id, owner_name: r.owner_name, total: 0, counts: zero(), stale_open: 0, breaking_sop: 0 };
    o.total++;
    o.counts[r.state]++;
    if (r.stale.length) o.stale_open++;
    if (!r.compliant) o.breaking_sop++;
    byOwner.set(r.owner_user_id, o);
  }
  const owners = [...byOwner.values()]
    .map((o) => ({ ...o, follows_sop: o.breaking_sop === 0 && o.stale_open === 0 }))
    .sort((a, b) => b.breaking_sop + b.stale_open - (a.breaking_sop + a.stale_open) || b.total - a.total);
  return { total: rows.length, counts, stale_open: staleOpen, breaking_sop: rows.filter((r) => !r.compliant).length, owners };
}

/** Every watch (no fixtures), classified, with the linked loops' status read once. */
export async function classifyAll(opts: { owner_user_id?: string | null; now?: Date } = {}) {
  const now = opts.now ?? new Date();
  const all = await dw.read({ fixtures: false });
  let watches = all.watches;
  if (opts.owner_user_id) watches = watches.filter((w) => w.owner_user_id === opts.owner_user_id);
  const loopIds = [...new Set(watches.filter((w) => w.status === 'watching' && w.record?.kind === 'loops').map((w) => w.record!.id as string))];
  const closed = new Set<string>();
  if (loopIds.length) {
    const r = await query<{ loop_id: string; status: string | null }>(
      `SELECT DISTINCT ON (natural_id) natural_id AS loop_id, fields->>'Status' AS status
         FROM engine_loops WHERE natural_id = ANY($1::text[]) ORDER BY natural_id, updated_at DESC`,
      [loopIds],
    );
    for (const row of r.rows) if (row.status === 'Closed') closed.add(row.loop_id);
  }
  const rows = watches.map((w) => classify(w, w.record?.kind === 'loops' ? closed.has(w.record.id as string) : null, now));
  return { rows, summary: summarise(rows), read_at: now.toISOString() };
}
