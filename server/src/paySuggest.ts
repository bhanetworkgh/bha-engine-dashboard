/**
 * LogStream pay suggestions (9 Nov 2026, Destiny; Jason's DM D0AF0DG8ZPY 1794237173.152349, the
 * "relog + partial pay" message). The engine works out a suggested pay note from what the review
 * found, so Jason starts from the right choice instead of from "full" every time. He still decides:
 * the suggestion is shown on his review card, pre-fills the Approve pop-up, and is kept beside the
 * pay note he picks (engine_pay_notes.suggested), so an override is always visible.
 *
 * Jason's policy, held here:
 *   - Follow-up logs on the same work are pay-eligible only for net-new Engine movement. A part of
 *     the log that re-narrates work already logged is docked, never held: re-narration is not paid
 *     later either.
 *   - Local-only or Phase A work is held, not paid: not merged in a PR, not hooked up where it has
 *     to be, or with a path that fails silently. Each held part names what has to happen for it.
 *   - Merged and hooked up but with no real Engine event yet is half now, half held until the first
 *     real event (his SOP of the same day).
 *   - A dock stays docked: payNote.set refuses any correction that would undo one.
 *
 * Where the facts come from: Layer 1 of Bays — Submit Actions reads the log and writes "Log Class",
 * "Relog Of", "Relog Delta" and "Work Parts" onto the Codex row (new field names, nothing renamed).
 * Every part is what the log says; a claim the log does not back (no PR, no event id) counts as not
 * done. The automatic code check confirms it against the live services later.
 *
 * Tuned 10 Nov 2026 (Destiny, after Kaiqi's questions on the change note, C0ASMPYQLG3 1794256210.264529;
 * the first night's real logs read stricter than the rule needs):
 *   - A part has a kind. "code" (software, a workflow, a config that runs) is judged as above. "non_code"
 *     (an investigation, a design, research, a review, a verification, an account or console change
 *     made by hand) can never be merged or deployed, so it is judged on its proof alone: credited when
 *     the log names what it produced, held only when it names nothing.
 *   - A log is a re-log only when some part of it is old. Layer 1 can call a continuation of earlier
 *     work a re-log while every part it lists is new this session; then the log is treated as new work
 *     and says so, instead of carrying the RELOG_OLD_WORK tag on work nobody docked.
 *   - LOCAL_ONLY is said only of code that is not merged or hooked up.
 *
 * The earlier-work check (`relogCheck`) is the engine's own read of the builder's approved logs:
 * the same recording, an earlier log named by id, or a loop shared with an approved log of theirs
 * in the last 14 days. Layer 0 of Submit Actions calls it before the completeness check and asks the
 * builder to classify the log when it finds something and the log does not say.
 */
import { query, type Queryable } from './pg';

type Obj = Record<string, unknown>;
const str = (v: unknown, max = 600): string => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : v == null ? '' : String(v).slice(0, max));
const bool = (v: unknown): boolean => v === true || v === 'true' || v === 'Yes' || v === 'yes';

export const LOG_CLASSES = ['fresh_build', 'RELOG_OLD_WORK'] as const;

export const PART_KINDS = ['code', 'non_code'] as const;
const NON_CODE = new Set(['non_code', 'noncode', 'non-code', 'investigation', 'design', 'research', 'review', 'verification', 'ops', 'docs', 'analysis']);

export interface WorkPart {
  what: string;
  kind: 'code' | 'non_code';
  new_this_session: boolean;
  merged: boolean;
  integrated: boolean;
  live_event: boolean;
  silent_failure: string;
  evidence: string;
}

export interface Suggestion {
  pay_recommendation: 'full' | 'half' | 'none' | 'custom_fraction';
  rest: 'hold' | 'dock';
  credited_share: number;
  held_share: number;
  docked_share: number;
  reason_tag: string | null;
  reason_note: string | null;
  release_condition: string | null;
  /** One line for the review card and the Approve pop-up. */
  line: string;
  /** What the review found that Jason should see, red flags first. */
  flags: string[];
  parts: (WorkPart & { score: number; status: 'live' | 'live_pending' | 'held' | 'already_paid'; missing: string[] })[];
  log_class: string | null;
  relog_of: string | null;
  relog_delta: string | null;
  basis: string;
  computed_at: string;
}

/** Work Parts as Layer 1 writes them: an array, or a JSON string of one. Anything else is no parts. */
export function parseParts(v: unknown): WorkPart[] {
  let a: unknown = v;
  if (typeof v === 'string') {
    try {
      a = JSON.parse(v);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(a)) return [];
  return a
    .filter((x): x is Obj => !!x && typeof x === 'object')
    .map((x) => ({
      what: str(x.what, 200) || 'unnamed part',
      kind: NON_CODE.has(str(x.kind, 40).toLowerCase()) ? ('non_code' as const) : ('code' as const),
      new_this_session: x.new_this_session === undefined ? true : bool(x.new_this_session),
      merged: bool(x.merged),
      integrated: bool(x.integrated),
      live_event: bool(x.live_event),
      silent_failure: str(x.silent_failure, 300),
      evidence: str(x.evidence, 300),
    }))
    .slice(0, 12);
}

const step = (n: number) => Math.round(n * 20) / 20; // to the nearest 0.05 of a day
const r3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * The suggestion, from the review's own fields. Pure. `null` when the review listed no work parts
 * and the log is not a re-log: then there is nothing to suggest from, and the card says so.
 */
export function suggest(fields: Obj, relog: RelogCheck | null = null, now = new Date()): Suggestion | null {
  const rawClass = str(fields['Log Class'], 40);
  const logClass = rawClass === 'RELOG_OLD_WORK' ? 'RELOG_OLD_WORK' : rawClass === 'fresh_build' ? 'fresh_build' : null;
  const relogOf = str(fields['Relog Of'], 300) || null;
  const relogDelta = str(fields['Relog Delta'], 600) || null;
  const parts = parseParts(fields['Work Parts']);
  const flags: string[] = [];

  const strong = (relog?.matches ?? []).filter((m) => m.strength === 'strong');
  if (relog?.unread) flags.push(`The earlier-work check could not run (${relog.unread}), so a re-log was not looked for.`);
  if (logClass !== 'RELOG_OLD_WORK' && strong.length) {
    flags.push(`The engine found earlier approved work this may repeat: ${strong.map((m) => `${m.codex_entry_id ?? m.submission_id} (${m.why})`).join('; ')}. Check it is new work.`);
  }

  if (!parts.length) {
    if (logClass !== 'RELOG_OLD_WORK') return null;
    // A re-log with nothing listed as new: re-narration of paid work, docked.
    const note = `Re-log of ${relogOf ?? 'earlier work'} with no new work stated${relogDelta ? ` (the log says: ${relogDelta})` : ''}. Re-narration of paid work is not paid.`;
    return finish({ credited: 0, held: 0, docked: 1, tag: 'RELOG_OLD_WORK', note, condition: null, flags, scored: [], logClass, relogOf, relogDelta, now, basis: 'Re-log with no work parts listed' });
  }

  const scored = parts.map((p) => {
    if (!p.new_this_session) {
      return { ...p, score: 0, status: 'already_paid' as const, missing: [] as string[] };
    }
    const missing: string[] = [];
    if (p.kind === 'non_code') {
      // Judged on its proof alone: what the investigation, design or check produced.
      const proven = !!p.evidence && !/^none( stated)?\.?$/i.test(p.evidence);
      if (!proven) missing.push('the proof it produced, named in the log (the doc, record, finding or link)');
      if (p.silent_failure) missing.push(`the "${p.silent_failure}" path writes a record instead of failing silently`);
      const ok = proven && !p.silent_failure;
      return { ...p, score: ok ? 1 : 0, status: ok ? ('live' as const) : ('held' as const), missing };
    }
    if (!p.merged) missing.push('merged in a PR with CI');
    if (!p.integrated) missing.push('hooked up where it runs (registered, deployed, wired in)');
    if (!p.live_event) missing.push('one real event for it in the Engine, logged');
    if (p.silent_failure) missing.push(`the "${p.silent_failure}" path writes a record instead of failing silently`);
    let score = 0;
    let status: 'live' | 'live_pending' | 'held' = 'held';
    if (p.merged && p.integrated && !p.silent_failure) {
      score = p.live_event ? 1 : 0.5;
      status = p.live_event ? 'live' : 'live_pending';
    }
    return { ...p, score, status, missing };
  });

  // A re-log whose builder named no delta: nothing in it can be counted as new.
  if (logClass === 'RELOG_OLD_WORK' && !relogDelta) {
    for (const p of scored) if (p.status !== 'already_paid') Object.assign(p, { score: 0, status: 'already_paid', missing: [] });
    flags.push('Classified as a re-log, but the log does not say what is new this session, so nothing in it is counted as new.');
  }

  for (const p of scored) if (p.silent_failure) flags.unshift(`Silent failure: ${p.what}: ${p.silent_failure}`);

  // A re-log only where some part is old: a continuation whose every part is new is new work.
  let effClass = logClass;
  if (logClass === 'RELOG_OLD_WORK' && !scored.some((p) => p.status === 'already_paid')) {
    effClass = 'fresh_build';
    flags.push(`The review called this a continuation${relogOf ? ` of ${relogOf}` : ''}, but every part is new this session, so it is treated as new work and nothing is docked.`);
  }

  const n = scored.length;
  const oldShare = scored.filter((p) => p.status === 'already_paid').length / n;
  const credited = step(scored.reduce((a, p) => a + p.score, 0) / n);
  const docked = step(oldShare);
  const held = r3(Math.max(0, 1 - credited - docked));

  const heldParts = scored.filter((p) => p.status === 'held' || p.status === 'live_pending');
  const condition = held > 0 ? heldParts.map((p) => `${p.what}: ${p.missing.join(', ')}`).join('. ').slice(0, 600) : null;

  const anyLocal = scored.some((p) => p.status === 'held' && p.kind === 'code' && (!p.merged || !p.integrated));
  const tag = docked > 0 ? 'RELOG_OLD_WORK' : held > 0 ? (anyLocal && scored.every((p) => p.score === 0) ? 'LOCAL_ONLY' : 'PARTIAL_SCOPE') : null;

  const bits: string[] = [];
  const credit = scored.filter((p) => p.score > 0);
  if (credit.length) bits.push(`Credited: ${credit.map((p) => (p.score < 1 ? `${p.what} (half, no live event yet)` : p.what)).join('; ')}`);
  if (heldParts.length) bits.push(`Held: ${heldParts.map((p) => p.what).join('; ')}`);
  const old = scored.filter((p) => p.status === 'already_paid');
  if (old.length) bits.push(`Docked as already paid${relogOf ? ` (${relogOf})` : ''}: ${old.map((p) => p.what).join('; ')}`);
  // A credit on a re-log has to say what it is for (payNote relog_needs_delta), even a full one.
  const note = tag || effClass === 'RELOG_OLD_WORK' ? `${effClass === 'RELOG_OLD_WORK' ? `Re-log of ${relogOf ?? 'earlier work'}; new this session: ${relogDelta ?? 'not stated'}. ` : ''}${bits.join('. ')}`.slice(0, 600) : null;

  return finish({ credited, held, docked, tag, note, condition, flags, scored, logClass: effClass, relogOf: effClass === 'RELOG_OLD_WORK' ? relogOf : null, relogDelta, now, basis: `${n} work part${n === 1 ? '' : 's'} from the review` });
}

function finish(a: {
  credited: number;
  held: number;
  docked: number;
  tag: string | null;
  note: string | null;
  condition: string | null;
  flags: string[];
  scored: Suggestion['parts'];
  logClass: string | null;
  relogOf: string | null;
  relogDelta: string | null;
  now: Date;
  basis: string;
}): Suggestion {
  const { credited, held, docked } = a;
  const rec: Suggestion['pay_recommendation'] =
    credited === 1 ? 'full' : credited === 0.5 && (held === 0.5 || docked === 0.5) ? 'half' : credited === 0 && (held === 1 || docked === 1) ? 'none' : 'custom_fraction';
  const rest: 'hold' | 'dock' = docked > 0 && held === 0 ? 'dock' : 'hold';
  const line =
    rec === 'full'
      ? 'Full day: everything in it is merged, hooked up and has a real event.'
      : `${credited} of a day now${held > 0 ? `, ${held} held` : ''}${docked > 0 ? `, ${docked} docked` : ''} (${a.tag})`;
  return {
    pay_recommendation: rec,
    rest,
    credited_share: credited,
    held_share: held,
    docked_share: docked,
    reason_tag: a.tag,
    reason_note: rec === 'full' && a.logClass !== 'RELOG_OLD_WORK' ? null : a.note,
    release_condition: held > 0 ? a.condition : null,
    line,
    flags: a.flags.slice(0, 8),
    parts: a.scored,
    log_class: a.logClass,
    relog_of: a.relogOf,
    relog_delta: a.relogDelta,
    basis: a.basis,
    computed_at: a.now.toISOString(),
  };
}

export interface RelogMatch {
  submission_id: string;
  codex_entry_id: string | null;
  session_description: string | null;
  approved_at: string | null;
  status: string;
  why: string;
  strength: 'strong' | 'medium';
}
export interface RelogCheck {
  matches: RelogMatch[];
  looks_like_relog: boolean;
  unread?: string;
}

const LOOP_RE = /LOOP-\d{10,}-[A-Z0-9]{4}/g;
const CODEX_RE = /CODEX-\d{8}-[a-z0-9-]+/gi;
const urlKey = (u: string) => u.split('?')[0].split('#')[0].replace(/\/+$/, '').toLowerCase();

/**
 * The builder's earlier approved logs this one may repeat. Only Approved or Input Added logs count:
 * the concern is work already paid. Strong: the same recording, or an earlier log named by its
 * Codex or Submission id. Medium: a loop id shared with an approved log of theirs in the last 14 days.
 */
export async function relogCheck(b: Obj, db: Queryable = { query } as Queryable): Promise<RelogCheck> {
  const builder = str(b.builder_user_id, 40);
  const self = str(b.submission_id, 200);
  const url = str(b.session_url, 1000);
  const text = typeof b.transcript === 'string' ? b.transcript.slice(0, 400_000) : '';
  if (!builder) return { matches: [], looks_like_relog: false, unread: 'no builder_user_id was given' };
  const r = await db.query<{ fields: Obj; updated_at: string }>(
    `SELECT fields, updated_at FROM engine_codex_submissions
      WHERE fields->>'Builder User ID' = $1 AND fields->>'Jason Status' IN ('Approved', 'Input Added')
        AND coalesce(fields->>'Submission ID', '') <> $2
      ORDER BY updated_at DESC LIMIT 400`,
    [builder, self],
  );
  const loops = new Set((text.match(LOOP_RE) ?? []).map((x) => x.toUpperCase()));
  const named = new Set((text.match(CODEX_RE) ?? []).map((x) => x.toLowerCase()));
  const cutoff = Date.now() - 14 * 86_400_000;
  const matches: RelogMatch[] = [];
  for (const row of r.rows) {
    const f = row.fields;
    const sub = str(f['Submission ID'], 200);
    const cid = str(f['Codex Entry ID'], 200) || null;
    const why: string[] = [];
    let strength: 'strong' | 'medium' | null = null;
    const theirUrl = str(f['Session Url'], 1000);
    if (url && theirUrl && urlKey(url) === urlKey(theirUrl)) {
      why.push('the same recording');
      strength = 'strong';
    }
    if ((cid && named.has(cid.toLowerCase())) || (sub && text.includes(sub))) {
      why.push('named in this log');
      strength = 'strong';
    }
    const when = str(f['Jason Reviewed At'], 40) || str(f['Processed At'], 40) || row.updated_at;
    if (!strength && loops.size && Date.parse(String(when)) >= cutoff) {
      const theirs = new Set((String(f.Transcript ?? '').match(LOOP_RE) ?? []).map((x) => x.toUpperCase()));
      const shared = [...loops].filter((l) => theirs.has(l));
      if (shared.length) {
        why.push(`works the same loop (${shared.slice(0, 3).join(', ')})`);
        strength = 'medium';
      }
    }
    if (strength) {
      matches.push({ submission_id: sub, codex_entry_id: cid, session_description: str(f['Session Description'], 160) || null, approved_at: str(when, 40) || null, status: str(f['Jason Status'], 40), why: why.join(', '), strength });
    }
  }
  matches.sort((a, b) => (a.strength === b.strength ? 0 : a.strength === 'strong' ? -1 : 1));
  return { matches: matches.slice(0, 8), looks_like_relog: matches.length > 0 };
}

/**
 * On every Codex write that carries the review's work parts or log class: the suggestion is worked
 * out and stored on the row as "Pay Suggestion" (JSON) beside them, so the review card, the Approve
 * pop-up and the dashboard all read one answer. A check that cannot run never stops the write.
 */
export async function annotate(fields: Obj, db: Queryable = { query } as Queryable): Promise<Obj> {
  if (!('Work Parts' in fields) && !('Log Class' in fields)) return fields;
  let relog: RelogCheck | null = null;
  try {
    relog = await relogCheck({ builder_user_id: fields['Builder User ID'], submission_id: fields['Submission ID'], session_url: fields['Session Url'], transcript: fields.Transcript }, db);
  } catch (e) {
    relog = { matches: [], looks_like_relog: false, unread: e instanceof Error ? e.message : String(e) };
  }
  const sug = suggest(fields, relog);
  return { ...fields, 'Pay Suggestion': sug ? JSON.stringify(sug) : JSON.stringify({ none: true, line: 'No suggestion: the review listed no work parts.', flags: relog?.unread ? [`The earlier-work check could not run (${relog.unread}).`] : [], computed_at: new Date().toISOString() }) };
}

/** The suggestion a Codex row carries, or null. */
export function fromRow(fields: Obj): (Partial<Suggestion> & { none?: boolean }) | null {
  const raw = fields['Pay Suggestion'];
  if (!raw) return null;
  try {
    const v = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return v && typeof v === 'object' ? (v as Partial<Suggestion> & { none?: boolean }) : null;
  } catch {
    return null;
  }
}
