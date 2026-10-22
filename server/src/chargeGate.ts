/**
 * The charge gate (2026-10-22, Destiny — Jason on the 22 Oct log, #workflow-logs-destiny
 * 1792686055.908889: "no real buyer gets charged until Hardik's acceptance pass is recorded as
 * green in the engine, and I have explicitly approved a live offer in a first-class record").
 *
 * Two kinds of record, append-only, one table (`engine_charge_gate`, migration 89):
 *   - acceptance_pass  — Hardik's verdict on the payment path: green or red.
 *   - offer_approval   — Jason's approval of a live offer on the rail: approved or withdrawn.
 *
 * Real buyers may be charged on a rail only while the newest acceptance_pass is green AND the
 * newest offer_approval is approved. Anything else, or nothing recorded, is "no". Nothing here
 * charges anyone, moves a stage or opens a checkout: it is the record the answer is read from.
 *
 * Who decides is held here, in code:
 *   - decided_by must be the kind's owner (Hardik for the pass, Jason for the offer);
 *   - evidence_link must be that person's own Slack message saying it, and Slack is asked:
 *     the message must exist and be posted by decided_by. Slack that cannot say is a refusal;
 *   - the person recording is the owner or Destiny (recording the owner's own words);
 *   - no agent may record one (the MCP tool refuses any agent token and is in no agent's scope).
 * A row is never edited or deleted: a change of mind is a new row (red, or withdrawn).
 *
 * `check()` is pure, so the rules are tested without a database or Slack.
 */
import { query, withTransaction } from './pg';
import { record } from './engineEvents';
import * as slack from './slack';

export const KINDS = ['acceptance_pass', 'offer_approval'] as const;
export type Kind = (typeof KINDS)[number];
export const RAILS = ['vfarm_stripe_live'] as const;
export type Rail = (typeof RAILS)[number];

export const HARDIK = 'U0BKT6MAW2Y';
export const JASON = 'U0A9V97949F';
export const DESTINY = 'U0AEW3TBYH1';

export const OWNER: Record<Kind, string> = { acceptance_pass: HARDIK, offer_approval: JASON };
export const OWNER_NAME: Record<Kind, string> = { acceptance_pass: 'Hardik', offer_approval: 'Jason' };
export const VERDICTS: Record<Kind, readonly string[]> = {
  acceptance_pass: ['green', 'red'],
  offer_approval: ['approved', 'withdrawn'],
};
const OPEN_VERDICT: Record<Kind, string> = { acceptance_pass: 'green', offer_approval: 'approved' };

export class ChargeGateError extends Error {
  constructor(public reason: string, message: string, public extra: Record<string, unknown> = {}) {
    super(message);
  }
}

export interface GateInput {
  kind: string;
  rail?: string | null;
  verdict: string;
  decided_by: string;
  evidence_link: string;
  scope?: string | null;
  notes?: string | null;
  recorded_by: string;
  test?: boolean;
}

export interface GateRow {
  gate_id: string;
  kind: Kind;
  rail: Rail;
  verdict: string;
  decided_by: string;
  evidence_link: string;
  evidence_channel: string;
  evidence_ts: string;
  scope: string | null;
  notes: string | null;
  recorded_by: string;
  via: string;
  test: boolean;
  created_at: string;
}

const clean = (v: unknown, max: number): string => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '');

/** A Slack message link → channel, ts and, for a reply, its thread's root. Null when it is not one. */
export function parseLink(link: string): { channel: string; ts: string; thread_ts: string | null } | null {
  let u: URL;
  try {
    u = new URL(link);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || !/^[a-z0-9-]+\.slack\.com$/i.test(u.hostname)) return null;
  const m = u.pathname.match(/^\/archives\/([CDG][A-Z0-9]+)\/p(\d{10})(\d{6})\/?$/);
  if (!m) return null;
  const thread = u.searchParams.get('thread_ts');
  return { channel: m[1], ts: `${m[2]}.${m[3]}`, thread_ts: thread && /^\d+\.\d+$/.test(thread) ? thread : null };
}

/** The rules, pure. Returns the cleaned input or throws ChargeGateError naming the rule. */
export function check(i: GateInput): { kind: Kind; rail: Rail; verdict: string; decided_by: string; evidence_link: string; link: NonNullable<ReturnType<typeof parseLink>>; scope: string | null; notes: string | null; recorded_by: string; test: boolean } {
  const kind = clean(i.kind, 40) as Kind;
  if (!KINDS.includes(kind)) throw new ChargeGateError('unknown_kind', `kind must be one of: ${KINDS.join(', ')}.`);
  const rail = (clean(i.rail, 60) || 'vfarm_stripe_live') as Rail;
  if (!RAILS.includes(rail)) throw new ChargeGateError('unknown_rail', `rail must be one of: ${RAILS.join(', ')}.`);
  const verdict = clean(i.verdict, 20).toLowerCase();
  if (!VERDICTS[kind].includes(verdict)) throw new ChargeGateError('unknown_verdict', `A ${kind} verdict is one of: ${VERDICTS[kind].join(', ')}.`);
  const decided_by = clean(i.decided_by, 20).replace(/^<@?([A-Z0-9]+)(\|[^>]*)?>$/, '$1');
  if (decided_by !== OWNER[kind]) {
    throw new ChargeGateError('not_the_owner', `A ${kind} is ${OWNER_NAME[kind]}'s alone (${OWNER[kind]}); decided_by was ${decided_by || 'empty'}.`);
  }
  const recorded_by = clean(i.recorded_by, 20).replace(/^<@?([A-Z0-9]+)(\|[^>]*)?>$/, '$1');
  if (recorded_by !== OWNER[kind] && recorded_by !== DESTINY) {
    throw new ChargeGateError('not_permitted', `A ${kind} is recorded by ${OWNER_NAME[kind]} or by Destiny from ${OWNER_NAME[kind]}'s own message; requester was ${recorded_by || 'empty'}.`);
  }
  const evidence_link = clean(i.evidence_link, 500);
  const link = parseLink(evidence_link);
  if (!link) throw new ChargeGateError('evidence_required', `evidence_link must be the Slack link (Copy link) of ${OWNER_NAME[kind]}'s own message saying this.`);
  const scope = clean(i.scope, 2000) || null;
  if (kind === 'offer_approval' && verdict === 'approved' && !scope) {
    throw new ChargeGateError('scope_required', 'An approved offer names what is approved in scope, in Jason\'s words (the offer, the price, who it is for). Nothing is filled in for him.');
  }
  const notes = clean(i.notes, 2000) || null;
  return { kind, rail, verdict, decided_by, evidence_link, link, scope, notes, recorded_by, test: i.test === true };
}

export type MessageCheck = (link: { channel: string; ts: string; thread_ts: string | null }) => Promise<{ ok: true; user: string | null } | { ok: false; reason: 'not_found' | 'unreadable'; message: string }>;

const SCOPE_ERRORS = new Set(['missing_scope', 'not_in_channel', 'channel_not_found', 'not_allowed_token_type']);

/** Asks Slack who posted the message. Bays first, North Star where Bays cannot read the place. */
export const slackAuthor: MessageCheck = async (link) => {
  const tokens: Array<{ token: string | undefined; as: string }> = [];
  if (slack.slackConfigured()) tokens.push({ token: undefined, as: 'Bays' });
  const ns = slack.northStarToken();
  if (ns) tokens.push({ token: ns, as: 'North Star' });
  if (!tokens.length) return { ok: false, reason: 'unreadable', message: 'No Slack token is set, so the message cannot be checked.' };
  const tried: string[] = [];
  for (const t of tokens) {
    const r = await slack.botCall('conversations.replies', { channel: link.channel, ts: link.thread_ts ?? link.ts, oldest: link.ts, latest: link.ts, inclusive: true, limit: 50 }, 'form', t.token);
    if (r.ok) {
      const m = ((r.messages as Array<{ ts?: string; user?: string }>) ?? []).find((x) => x.ts === link.ts);
      if (!m) return { ok: false, reason: 'not_found', message: `Slack has no message ${link.ts} in ${link.channel}.` };
      return { ok: true, user: m.user ?? null };
    }
    const error = String(r.error);
    if (error === 'thread_not_found' || error === 'message_not_found') return { ok: false, reason: 'not_found', message: `Slack has no message ${link.ts} in ${link.channel} (${error}).` };
    tried.push(`${t.as}: ${error}`);
    if (!SCOPE_ERRORS.has(error)) break;
  }
  return { ok: false, reason: 'unreadable', message: `Could not read ${link.channel} to check who posted it (${tried.join('; ')}).` };
};

const toRow = (r: Record<string, unknown>): GateRow => ({
  gate_id: String(r.gate_id),
  kind: r.kind as Kind,
  rail: r.rail as Rail,
  verdict: String(r.verdict),
  decided_by: String(r.decided_by),
  evidence_link: String(r.evidence_link),
  evidence_channel: String(r.evidence_channel),
  evidence_ts: String(r.evidence_ts),
  scope: (r.scope as string) ?? null,
  notes: (r.notes as string) ?? null,
  recorded_by: String(r.recorded_by),
  via: String(r.via),
  test: r.test === true,
  created_at: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
});

function newId(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 4; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return `CG-${Date.now()}-${s}`;
}

/** Records one verdict, with its engine event, in one transaction. Refused with nothing written when a rule says no. */
export async function recordGate(
  input: GateInput,
  opts: { via: string; dry_run?: boolean; checkMessage?: MessageCheck } = { via: 'unknown' },
): Promise<{ ok: true; written: boolean; row: GateRow; event_id: number | null; status: RailStatus; message: string }> {
  const c = check(input);
  const verify = opts.checkMessage ?? slackAuthor;
  const seen = await verify(c.link);
  if (!seen.ok) {
    throw new ChargeGateError(seen.reason === 'not_found' ? 'evidence_not_found' : 'evidence_unchecked', `${seen.message} Nothing was recorded: a ${c.kind} counts only on a message Slack confirms is ${OWNER_NAME[c.kind]}'s.`);
  }
  if (seen.user !== c.decided_by) {
    throw new ChargeGateError('evidence_not_owners', `That message was posted by ${seen.user ?? 'a bot or an unknown sender'}, not ${OWNER_NAME[c.kind]} (${c.decided_by}). Link ${OWNER_NAME[c.kind]}'s own message.`);
  }
  const row: GateRow = {
    gate_id: newId(),
    kind: c.kind,
    rail: c.rail,
    verdict: c.verdict,
    decided_by: c.decided_by,
    evidence_link: c.evidence_link,
    evidence_channel: c.link.channel,
    evidence_ts: c.link.ts,
    scope: c.scope,
    notes: c.notes,
    recorded_by: c.recorded_by,
    via: opts.via,
    test: c.test,
    created_at: new Date().toISOString(),
  };
  if (opts.dry_run) {
    const before = await status(c.rail);
    return { ok: true, written: false, row, event_id: null, status: before, message: `Dry run: ${OWNER_NAME[c.kind]}'s ${c.kind} (${c.verdict}) would be recorded on ${c.rail}. Nothing was written.` };
  }
  const event_id = await withTransaction(async (db) => {
    const ins = await db.query(
      `INSERT INTO engine_charge_gate (gate_id, kind, rail, verdict, decided_by, evidence_link, evidence_channel, evidence_ts, scope, notes, recorded_by, via, test)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING created_at`,
      [row.gate_id, row.kind, row.rail, row.verdict, row.decided_by, row.evidence_link, row.evidence_channel, row.evidence_ts, row.scope, row.notes, row.recorded_by, row.via, row.test],
    );
    row.created_at = (ins.rows[0] as { created_at: Date }).created_at.toISOString();
    const e = await record(
      {
        event_type: 'charge_gate_recorded',
        subject_id: row.rail,
        lane: 'VFARM',
        actor: row.recorded_by,
        source_ref: row.evidence_link,
        detail: { gate_id: row.gate_id, kind: row.kind, verdict: row.verdict, decided_by: row.decided_by, test: row.test },
        dedupe_key: `charge_gate:${row.gate_id}`,
      },
      db,
    );
    return e.id;
  });
  const after = await status(c.rail);
  return {
    ok: true,
    written: true,
    row,
    event_id,
    status: after,
    message: `Recorded ${OWNER_NAME[c.kind]}'s ${c.kind}: ${c.verdict}${row.test ? ' (TEST, never counts)' : ''}. Real buyers can be charged on ${c.rail}: ${after.can_charge_live ? 'yes' : 'no'}.`,
  };
}

export interface RailStatus {
  rail: Rail;
  can_charge_live: boolean;
  acceptance_pass: GateRow | null;
  offer_approval: GateRow | null;
  missing: string[];
  answer: string;
}

/** The pure decision from the newest real row of each kind. */
export function decide(rail: Rail, pass: GateRow | null, offer: GateRow | null): RailStatus {
  const missing: string[] = [];
  if (!pass) missing.push("Hardik's acceptance pass has not been recorded");
  else if (pass.verdict !== OPEN_VERDICT.acceptance_pass) missing.push(`Hardik's newest acceptance pass is ${pass.verdict} (${pass.created_at.slice(0, 10)})`);
  if (!offer) missing.push("Jason's live-offer approval has not been recorded");
  else if (offer.verdict !== OPEN_VERDICT.offer_approval) missing.push(`Jason's newest offer approval is ${offer.verdict} (${offer.created_at.slice(0, 10)})`);
  const can = missing.length === 0;
  return {
    rail,
    can_charge_live: can,
    acceptance_pass: pass,
    offer_approval: offer,
    missing,
    answer: can
      ? `Yes, within what Jason approved: "${offer?.scope ?? ''}". Hardik's pass is green (${pass?.created_at.slice(0, 10)}) and Jason approved a live offer (${offer?.created_at.slice(0, 10)}).`
      : `No. ${missing.join('; ')}. Real buyers can't be charged until both are recorded.`,
  };
}

/** Where a rail stands now. Test rows never count. A failed read throws: the caller says it does not know. */
export async function status(rail: Rail = 'vfarm_stripe_live'): Promise<RailStatus> {
  const r = await query<Record<string, unknown>>(
    `SELECT DISTINCT ON (kind) * FROM engine_charge_gate WHERE rail = $1 AND test = false ORDER BY kind, created_at DESC, gate_id DESC`,
    [rail],
  );
  const rows = r.rows.map(toRow);
  return decide(rail, rows.find((x) => x.kind === 'acceptance_pass') ?? null, rows.find((x) => x.kind === 'offer_approval') ?? null);
}

/** Every row, newest first, for a person checking the history. */
export async function history(opts: { rail?: Rail; include_test?: boolean; limit?: number } = {}): Promise<GateRow[]> {
  const limit = Math.max(1, Math.min(200, Math.floor(Number(opts.limit)) || 50));
  const r = await query<Record<string, unknown>>(
    `SELECT * FROM engine_charge_gate WHERE ($1::text IS NULL OR rail = $1) AND ($2 OR test = false) ORDER BY created_at DESC, gate_id DESC LIMIT $3`,
    [opts.rail ?? null, opts.include_test === true, limit],
  );
  return r.rows.map(toRow);
}

export const RULES = [
  'Real buyers may be charged on a rail only while the newest acceptance_pass is green AND the newest offer_approval is approved. Nothing recorded means no.',
  "acceptance_pass is Hardik's (U0BKT6MAW2Y) and offer_approval is Jason's (U0A9V97949F). Each counts only on that person's own Slack message, which Slack confirms they posted.",
  'Rows are never edited or deleted: a red pass or a withdrawn approval is a new row, and the newest row of each kind is the one that counts.',
  'A test row never counts. No agent may record either kind.',
  'This record charges nobody, moves no stage and opens no checkout. Anything said in public still needs read_publication_decision.',
];
