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
 * Jason's proof levels (10 Nov 2026, the change-note thread C0ASMPYQLG3 1794256210.264529, DW-1794313591288-PVMC).
 * Every new part is scored on the proof the log gives, not on whether it has reached production:
 *   - Level 0, narrative only (nothing another person can open): held, INSUFFICIENT_PROOF.
 *   - Level 1, an artefact (a PR, a pushed branch or commit, a script, a design, test output): credited.
 *   - Level 2, a call on the target surface (HTTPS, CLI, queue, simulator, Slack) with an effect seen.
 *   - Level 3, a live production event.
 *   Level 1 and up is credited in full. A hold is only for INSUFFICIENT_PROOF, or NEEDS_LIVE_EVENT where
 *   the loop's acceptance needs a live event (or the log says the part is live) and there is none yet:
 *   then half now, half held until it lands. Never held for "not in prod", for waiting on review with a
 *   real artefact, or for being blocked by someone else once the work is ready: those are credited and
 *   tagged AWAITING_REVIEW or BLOCKED_EXTERNAL so the wait is visible. Old work is still docked.
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

export const BLOCKERS = ['awaiting_review', 'blocked_external', 'awaiting_customer'] as const;

export interface WorkPart {
  what: string;
  kind: 'code' | 'non_code';
  /** Jason's proof level, 0 to 3: what the log gives (see the header). */
  proof_level: 0 | 1 | 2 | 3;
  /** Whether the level was stated by the review or worked out here from the older fields. */
  level_from: 'review' | 'derived';
  /**
   * The work is ready and waits on someone else: a review of its artefact, another team, or (from
   * 11 Nov 2026) a customer or member of the public choosing to act (a signup, a payment, a call).
   */
  blocker: '' | 'awaiting_review' | 'blocked_external' | 'awaiting_customer';
  /** The loop's acceptance needs a live production event for this part, or the log says it is live. */
  needs_live_event: boolean;
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
  parts: (WorkPart & { score: number; status: 'live' | 'live_pending' | 'held' | 'already_paid'; missing: string[]; tag: string | null })[];
  log_class: string | null;
  relog_of: string | null;
  relog_delta: string | null;
  basis: string;
  computed_at: string;
  /** Pay held on this builder's earlier logs that this log brings the proof for (11 Nov 2026). */
  releases?: Releases | null;
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
    .map((x) => {
      const kind = NON_CODE.has(str(x.kind, 40).toLowerCase()) ? ('non_code' as const) : ('code' as const);
      const merged = bool(x.merged);
      const integrated = bool(x.integrated);
      const live_event = bool(x.live_event);
      const evidence = str(x.evidence, 300);
      const stated = Number(x.proof_level);
      const fromReview = x.proof_level !== undefined && x.proof_level !== null && x.proof_level !== '' && [0, 1, 2, 3].includes(stated);
      const proof_level = (fromReview ? stated : deriveLevel({ merged, integrated, live_event, evidence })) as 0 | 1 | 2 | 3;
      const b = str(x.blocker, 40).toLowerCase();
      const blocker = (BLOCKERS as readonly string[]).includes(b)
        ? (b as 'awaiting_review' | 'blocked_external' | 'awaiting_customer')
        : // Older rows carry no blocker: finished code with an artefact that is not merged waits on review.
          x.blocker === undefined && kind === 'code' && proof_level >= 1 && !merged
          ? 'awaiting_review'
          : '';
      return {
        what: str(x.what, 200) || 'unnamed part',
        kind,
        proof_level,
        level_from: fromReview ? ('review' as const) : ('derived' as const),
        blocker: blocker as WorkPart['blocker'],
        needs_live_event: bool(x.needs_live_event),
        new_this_session: x.new_this_session === undefined ? true : bool(x.new_this_session),
        merged,
        integrated,
        live_event,
        silent_failure: str(x.silent_failure, 300),
        evidence,
      };
    })
    .slice(0, 12);
}

const hasEvidence = (e: string) => !!e && !/^(none|n\/a|no(ne)? (stated|given|proof))\.?$/i.test(e.trim());

/** A level for a part the review did not grade (rows written before 10 Nov): from the older fields. Pure. */
export function deriveLevel(p: { merged: boolean; integrated: boolean; live_event: boolean; evidence: string }): 0 | 1 | 2 | 3 {
  if (p.live_event) return 3;
  if (p.integrated && (p.merged || hasEvidence(p.evidence))) return 2;
  if (p.merged || hasEvidence(p.evidence)) return 1;
  return 0;
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

  const scored: Suggestion['parts'] = parts.map((p) => {
    if (!p.new_this_session) {
      return { ...p, score: 0, status: 'already_paid' as const, missing: [] as string[], tag: 'RELOG_OLD_WORK' };
    }
    const missing: string[] = [];
    if (p.silent_failure) {
      missing.push(`the "${p.silent_failure}" path writes a record instead of failing silently`);
      return { ...p, score: 0, status: 'held' as const, missing, tag: 'INSUFFICIENT_PROOF' };
    }
    if (p.proof_level === 0) {
      missing.push(p.kind === 'non_code' ? 'the proof it produced, named in the log (the doc, record, finding or link)' : 'an artefact another person can open: a PR, a pushed branch or commit, a script, a design or test output');
      return { ...p, score: 0, status: 'held' as const, missing, tag: 'INSUFFICIENT_PROOF' };
    }
    // A live event that only a customer or member of the public can make happen (a real signup, a real
    // payment) is not the builder's to prove (Destiny, 11 Nov 2026): the part is credited once it is ready,
    // tagged WAITING_ON_CUSTOMER so the wait is seen, and the first real customer event is still watched for.
    if (p.needs_live_event && p.proof_level < 3 && p.blocker === 'awaiting_customer' && p.proof_level >= 1) {
      return { ...p, score: 1, status: 'live' as const, missing, tag: 'WAITING_ON_CUSTOMER' };
    }
    if (p.needs_live_event && p.proof_level < 3) {
      missing.push('one real production event for it, logged');
      return { ...p, score: 0.5, status: 'live_pending' as const, missing, tag: 'NEEDS_LIVE_EVENT' };
    }
    const tag = p.blocker === 'awaiting_review' ? 'AWAITING_REVIEW' : p.blocker === 'blocked_external' ? 'BLOCKED_EXTERNAL' : null;
    return { ...p, score: 1, status: 'live' as const, missing, tag };
  });

  // A re-log whose builder named no delta: nothing in it can be counted as new.
  if (logClass === 'RELOG_OLD_WORK' && !relogDelta) {
    for (const p of scored) if (p.status !== 'already_paid') Object.assign(p, { score: 0, status: 'already_paid', missing: [], tag: 'RELOG_OLD_WORK' });
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

  // One tag for the note: the docked share first, then the larger held reason, then a visible wait.
  const heldBy = (t: string) => scored.filter((p) => p.tag === t).reduce((x, p) => x + (1 - p.score), 0);
  const waits = scored.filter((p) => p.status === 'live').map((p) => p.tag).filter((t): t is string => !!t);
  const tag =
    docked > 0
      ? 'RELOG_OLD_WORK'
      : held > 0
        ? heldBy('INSUFFICIENT_PROOF') >= heldBy('NEEDS_LIVE_EVENT')
          ? 'INSUFFICIENT_PROOF'
          : 'NEEDS_LIVE_EVENT'
        : waits.includes('BLOCKED_EXTERNAL')
          ? 'BLOCKED_EXTERNAL'
          : waits.includes('WAITING_ON_CUSTOMER')
            ? 'WAITING_ON_CUSTOMER'
            : waits.includes('AWAITING_REVIEW')
              ? 'AWAITING_REVIEW'
              : null;

  const bits: string[] = [];
  const credit = scored.filter((p) => p.score > 0);
  const lvl = (p: { proof_level: number }) => `level ${p.proof_level}`;
  if (credit.length) bits.push(`Credited: ${credit.map((p) => (p.score < 1 ? `${p.what} (${lvl(p)}; 50%, its live event is not in yet)` : `${p.what} (${lvl(p)}${p.tag ? `, ${p.tag}` : ''})`)).join('; ')}`);
  const heldOnly = scored.filter((p) => p.status === 'held');
  if (heldOnly.length) bits.push(`Held: ${heldOnly.map((p) => `${p.what} (${p.tag})`).join('; ')}`);
  const old = scored.filter((p) => p.status === 'already_paid');
  if (old.length) bits.push(`Docked as already paid${relogOf ? ` (${relogOf})` : ''}: ${old.map((p) => p.what).join('; ')}`);
  // A credit on a re-log has to say what it is for (payNote relog_needs_delta), even a full one.
  const note = tag || effClass === 'RELOG_OLD_WORK' ? `${effClass === 'RELOG_OLD_WORK' ? `Re-log of ${relogOf ?? 'earlier work'}; new this session: ${relogDelta ?? 'not stated'}. ` : ''}${bits.join('. ')}`.slice(0, 600) : null;

  return finish({ credited, held, docked, tag, note, condition, flags, scored, logClass: effClass, relogOf: effClass === 'RELOG_OLD_WORK' ? relogOf : null, relogDelta, now, basis: `${n} work part${n === 1 ? '' : 's'} from the review` });
}

/** A share of a day as a percentage, for people to read (10 Nov 2026, Destiny). Stored shares stay 0 to 1. Pure. */
export function pct(n: number): string {
  return `${Math.round(n * 1000) / 10}%`;
}

/** The one-line suggestion, worked out from the shares, so a card can be redrawn from any stored suggestion. Pure. */
export function lineFor(s: { pay_recommendation?: string | null; credited_share?: number | null; held_share?: number | null; docked_share?: number | null; reason_tag?: string | null }): string {
  if (s.pay_recommendation === 'full') {
    const wait =
      s.reason_tag === 'AWAITING_REVIEW'
        ? ' Some of it is waiting on review (AWAITING_REVIEW).'
        : s.reason_tag === 'BLOCKED_EXTERNAL'
          ? ' Some of it is blocked by someone else (BLOCKED_EXTERNAL).'
          : s.reason_tag === 'WAITING_ON_CUSTOMER'
            ? ' Some of it waits on a real customer to act (WAITING_ON_CUSTOMER).'
            : '';
    return `Full day (100%): every part has the proof it needs.${wait}`;
  }
  const c = s.credited_share ?? 0;
  const h = s.held_share ?? 0;
  const d = s.docked_share ?? 0;
  return `${pct(c)} of a day now${h > 0 ? `, ${pct(h)} held` : ''}${d > 0 ? `, ${pct(d)} docked` : ''}${s.reason_tag ? ` (${s.reason_tag})` : ''}`;
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
  const line = lineFor({ pay_recommendation: rec, credited_share: credited, held_share: held, docked_share: docked, reason_tag: a.tag });
  return {
    pay_recommendation: rec,
    rest,
    credited_share: credited,
    held_share: held,
    docked_share: docked,
    reason_tag: a.tag,
    reason_note: rec === 'full' && a.logClass !== 'RELOG_OLD_WORK' && !a.tag ? null : a.note,
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

/*
 * Releases: pay held on a builder's earlier logs, released when a later log brings the proof (11 Nov 2026,
 * Destiny: "so that builders are not losing out on money"). Layer 1 lists in "Releases" every earlier log
 * the new log says it brings proof for, part by part, with the proof and its level. The engine matches each
 * claim to a pay note of that builder still holding a share, part by part, and judges it by the reason the
 * part was held: a part held for a live event needs a level 3 event (or, when only a customer can make it
 * happen, is credited as WAITING_ON_CUSTOMER); a part held for missing proof needs something another
 * person can open. Nothing is released here: the card shows it, and Jason's Approve click releases it.
 * Every hold of the builder that the log does not address is listed too, so it is never forgotten.
 */
export interface ReleaseClaimPart {
  what: string;
  proof: string;
  proof_level: 0 | 1 | 2 | 3;
  awaiting_customer: boolean;
}
export interface ReleaseClaim {
  log: string;
  parts: ReleaseClaimPart[];
}
export interface HoldRow {
  submission_id: string;
  codex_entry_id: string | null;
  held_share: number;
  release_condition: string | null;
  reason_tag: string | null;
  suggested: Obj | null;
  released_parts: string[];
}
export interface ReleasePart {
  what: string;
  held_for: string;
  share: number;
  ok: boolean;
  proof: string;
  why: string;
}
export interface ReleaseItem {
  submission_id: string;
  codex_entry_id: string | null;
  held_share: number;
  release_share: number;
  parts: ReleasePart[];
  still_held: string[];
}
export interface Releases {
  items: ReleaseItem[];
  open: { submission_id: string; codex_entry_id: string | null; held_share: number; release_condition: string | null }[];
  total_share: number;
  line: string;
}

/** Releases as Layer 1 writes them: an array, or a JSON string of one. Pure. */
export function parseReleases(v: unknown): ReleaseClaim[] {
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
      log: str(x.log ?? x.codex_entry_id ?? x.submission_id, 200),
      parts: (Array.isArray(x.parts) ? x.parts : [])
        .filter((y): y is Obj => !!y && typeof y === 'object')
        .map((y) => {
          const lv = Number(y.proof_level);
          return { what: str(y.what, 200), proof: str(y.proof ?? y.evidence, 300), proof_level: ([0, 1, 2, 3].includes(lv) ? lv : 0) as 0 | 1 | 2 | 3, awaiting_customer: bool(y.awaiting_customer) };
        })
        .slice(0, 12),
    }))
    .filter((c) => c.log)
    .slice(0, 8);
}

const words = (t: string) => new Set(t.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w.length > 2));
function overlap(a: string, b: string): number {
  const x = words(a);
  const y = words(b);
  if (!x.size || !y.size) return 0;
  let n = 0;
  for (const w of x) if (y.has(w)) n++;
  return n / Math.min(x.size, y.size);
}

/** The held parts of one pay note, each with its share of a day. Parts already released are left out. Pure. */
export function heldParts(h: HoldRow): { what: string; held_for: string; share: number }[] {
  const parts = Array.isArray(h.suggested?.parts) ? (h.suggested!.parts as Obj[]) : [];
  const done = new Set(h.released_parts.map((x) => x.toLowerCase()));
  const list = parts
    .filter((p) => (p.status === 'held' || p.status === 'live_pending') && !done.has(String(p.what ?? '').toLowerCase()))
    .map((p) => ({ what: str(p.what, 200), held_for: str(p.tag, 40) || 'held', raw: (1 - Number(p.score ?? 0)) / Math.max(1, parts.length) }));
  if (!list.length) return h.held_share > 0 ? [{ what: h.release_condition || 'the held share', held_for: h.reason_tag || 'held', share: r3(h.held_share) }] : [];
  // The note as Jason decided it is what is owed: scale the review's split to the share still held.
  const sum = list.reduce((a, p) => a + p.raw, 0);
  return list.map((p) => ({ what: p.what, held_for: p.held_for, share: r3(sum > 0 ? (p.raw / sum) * h.held_share : h.held_share / list.length) }));
}

/** Matches what a log claims against the builder's open holds. Pure. */
export function matchReleases(holds: HoldRow[], claims: ReleaseClaim[]): Releases {
  const items: ReleaseItem[] = [];
  const open: Releases['open'] = [];
  for (const h of holds) {
    if (h.held_share <= 0) continue;
    const ids = [h.codex_entry_id, h.submission_id].filter((x): x is string => !!x).map((x) => x.toLowerCase());
    const claim = claims.find((c) => ids.some((id) => c.log.toLowerCase().includes(id) || id.includes(c.log.toLowerCase())));
    if (!claim) {
      open.push({ submission_id: h.submission_id, codex_entry_id: h.codex_entry_id, held_share: h.held_share, release_condition: h.release_condition });
      continue;
    }
    const parts: ReleasePart[] = heldParts(h).map((p) => {
      let best: ReleaseClaimPart | null = null;
      let score = 0;
      for (const c of claim.parts) {
        const o = overlap(p.what, c.what);
        if (o > score) {
          score = o;
          best = c;
        }
      }
      if (!best || score < 0.5) return { ...p, ok: false, proof: '', why: 'this log does not bring proof for it' };
      if (!hasEvidence(best.proof)) return { ...p, ok: false, proof: '', why: 'claimed, but no proof is named' };
      const live = p.held_for === 'NEEDS_LIVE_EVENT' || p.held_for === 'TEST_ONLY';
      if (live) {
        if (best.proof_level >= 3) return { ...p, ok: true, proof: best.proof, why: 'a real production event is named' };
        if (best.awaiting_customer && best.proof_level >= 1) return { ...p, ok: true, proof: best.proof, why: 'its live event waits on a real customer, which is not the builder\'s to prove (WAITING_ON_CUSTOMER)' };
        return { ...p, ok: false, proof: best.proof, why: `the proof named is level ${best.proof_level}; this part was held for a real production event` };
      }
      if (best.proof_level >= 1) return { ...p, ok: true, proof: best.proof, why: 'proof another person can open is named' };
      return { ...p, ok: false, proof: best.proof, why: 'the proof named is narrative only' };
    });
    const release_share = r3(Math.min(h.held_share, parts.filter((p) => p.ok).reduce((a, p) => a + p.share, 0)));
    items.push({ submission_id: h.submission_id, codex_entry_id: h.codex_entry_id, held_share: h.held_share, release_share, parts, still_held: parts.filter((p) => !p.ok).map((p) => p.what) });
  }
  const total_share = r3(items.reduce((a, i) => a + i.release_share, 0));
  const ready = items.filter((i) => i.release_share > 0);
  const line = ready.length
    ? `Release from earlier logs: ${ready.map((i) => `${i.codex_entry_id ?? i.submission_id} ${pct(i.release_share)} of a day (${i.parts.filter((p) => p.ok).length} of ${i.parts.length} held parts proven)`).join('; ')}.`
    : items.length
      ? 'This log names earlier held pay, but none of it is proven yet.'
      : '';
  return { items, open, total_share, line };
}

/** The builder's open holds and what this log brings for them, or null when the builder holds nothing. */
export async function releasesFor(fields: Obj, db: Queryable = { query } as Queryable): Promise<Releases | null> {
  const builder = str(fields['Builder User ID'], 40);
  const self = str(fields['Submission ID'], 200);
  if (!builder) return null;
  const r = await db.query<{ submission_id: string; codex_entry_id: string | null; held_share: number; release_condition: string | null; reason_tag: string | null; suggested: Obj | null; released_parts: string[] | null }>(
    `SELECT submission_id, codex_entry_id, held_share::float8 AS held_share, release_condition, reason_tag, suggested, released_parts
       FROM engine_pay_notes WHERE builder_slack_id = $1 AND held_share > 0 AND submission_id <> $2
      ORDER BY decided_at DESC LIMIT 30`,
    [builder, self],
  );
  if (!r.rows.length) return null;
  const holds: HoldRow[] = r.rows.map((x) => ({ ...x, held_share: Number(x.held_share), released_parts: Array.isArray(x.released_parts) ? x.released_parts : [] }));
  return matchReleases(holds, parseReleases(fields.Releases));
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
  // Earlier held pay this log may release (11 Nov 2026). A check that cannot run never stops the write,
  // and says so on the card rather than reading as "nothing held".
  let releases: Releases | null = null;
  let releasesUnread = '';
  try {
    releases = await releasesFor(fields, db);
  } catch (e) {
    releasesUnread = e instanceof Error ? e.message : String(e);
  }
  const base = sug ?? { none: true, line: 'No suggestion: the review listed no work parts.', flags: relog?.unread ? [`The earlier-work check could not run (${relog.unread}).`] : [], computed_at: new Date().toISOString() };
  const flags = releasesUnread ? [...((base as { flags?: string[] }).flags ?? []), `The held-pay check could not run (${releasesUnread}), so earlier held pay was not looked at.`] : (base as { flags?: string[] }).flags;
  return { ...fields, 'Pay Suggestion': JSON.stringify({ ...base, flags, releases }) };
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
