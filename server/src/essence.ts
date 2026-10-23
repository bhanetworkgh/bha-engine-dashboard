/**
 * Essence markers (24 Oct 2026, Destiny — LOOP-1792428941802-0LEW; Jason's three calls of 23 Oct,
 * #bha-coordination 1792773102.009109). The contract is docs/contracts/essence-markers.md.
 *
 * A marker is one line about how a person decides (a decision rule, a trade-off, a debugging
 * instinct, a standard they hold, or their voice), always carrying the exact sentence from their
 * own words it came from. One table, `engine_essence_markers` (migration 93).
 *
 * The rules, held here in code:
 *   - **No quote, no marker.** A codex marker's quote must appear in that log's own `Transcript`
 *     (the builder's narration, never the model's review of it), and the log must be that
 *     person's. A founder marker's quote must appear in a Slack message that Slack confirms the
 *     founder posted. A quote that cannot be found is refused and nothing is written.
 *   - **Confirmation is the person's alone.** A marker is `proposed` until its subject clicks
 *     "That's me" (`confirmed`) or "Not me" (`rejected`). Nobody confirms for anyone, Destiny and
 *     Jason included. Only confirmed and stable markers are ever read by a twin.
 *   - **Private by default.** `published` is false until the subject chooses to share a confirmed
 *     marker. `read_essence` serves the engine (Bays, Genie, the twins); a public copy carries
 *     published markers only, and nothing is published automatically.
 *   - **Stable at three.** A confirmed marker whose line turns up again is not a second row: the
 *     new source is added to `seen_in`, and at three distinct sources it becomes `stable`.
 *   - **A rejected line is not proposed again.** The subject said "Not me".
 *   - **Never pay.** Nothing here is read by Logstream, pay or any score.
 *
 * `check()` and `quoteIn()` are pure, so the rules are tested without a database or Slack.
 */
import { query, withTransaction } from './pg';
import { record } from './engineEvents';
import * as slack from './slack';
import { parseLink } from './chargeGate';

export const KINDS = ['decision_rule', 'trade_off', 'debugging_instinct', 'standard', 'voice'] as const;
export type Kind = (typeof KINDS)[number];
export const SOURCE_KINDS = ['codex_log', 'review', 'architect_answer', 'doctrine_post'] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];
export const STATUSES = ['proposed', 'confirmed', 'rejected', 'stable'] as const;
export type Status = (typeof STATUSES)[number];
export const ACTIONS = ['confirm', 'reject', 'publish', 'unpublish'] as const;
export type Action = (typeof ACTIONS)[number];

/** The numbers, here and nowhere else. */
export const RULE = {
  max_per_source: 3,
  stable_at_sources: 3,
  quote_min_chars: 15,
  quote_max_chars: 400,
  line_max_chars: 280,
} as const;

export class EssenceError extends Error {
  constructor(public reason: string, message: string, public extra: Record<string, unknown> = {}) {
    super(message);
  }
}

export interface MarkerRow {
  marker_id: string;
  subject_id: string;
  subject_name: string | null;
  kind: Kind;
  line: string;
  quote: string;
  source_kind: SourceKind;
  source_ref: string;
  seen_in: string[];
  status: Status;
  published: boolean;
  confidence: number | null;
  proposed_by: string;
  decided_by: string | null;
  decided_at: string | null;
  decision_note: string | null;
  test: boolean;
  created_at: string;
  updated_at: string;
}

const clean = (v: unknown, max: number): string => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');
const slackId = (v: unknown): string => clean(v, 40).replace(/^<@?([A-Z0-9]+)(\|[^>]*)?>$/, '$1');

/** Text for comparing: lower case, curly quotes and dashes made plain, whitespace collapsed, end punctuation dropped. */
export function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^[\s"'.,;:!?-]+|[\s"'.,;:!?-]+$/g, '')
    .trim();
}

/** Is the quote in the text, word for word (case, curly quotes and spacing aside)? Pure. */
export function quoteIn(quote: string, text: string | null | undefined): boolean {
  if (!text) return false;
  const q = norm(quote);
  return q.length >= RULE.quote_min_chars && norm(text).includes(q);
}

export interface ProposeInput {
  subject_id: string;
  kind: string;
  line: string;
  quote: string;
  source_kind: string;
  source_ref: string;
  confidence?: number | null;
  proposed_by: string;
  test?: boolean;
}

/** The shape rules, pure. Returns the cleaned input or throws EssenceError naming the rule. */
export function check(i: ProposeInput): { subject_id: string; kind: Kind; line: string; quote: string; source_kind: SourceKind; source_ref: string; confidence: number | null; proposed_by: string; test: boolean } {
  const subject_id = slackId(i.subject_id);
  if (!/^[UW][A-Z0-9]{6,}$/.test(subject_id)) throw new EssenceError('subject_required', 'subject_id is the Slack id of the person the marker is about.');
  const kind = clean(i.kind, 40) as Kind;
  if (!KINDS.includes(kind)) throw new EssenceError('unknown_kind', `kind is one of: ${KINDS.join(', ')}. A task is never a marker.`);
  const line = clean(i.line, RULE.line_max_chars + 1);
  if (line.length < 8) throw new EssenceError('line_required', 'line is the marker itself: one line about how this person decides.');
  if (line.length > RULE.line_max_chars) throw new EssenceError('line_too_long', `A marker is one line, ${RULE.line_max_chars} characters at most.`);
  const quote = clean(i.quote, RULE.quote_max_chars + 1);
  if (norm(quote).length < RULE.quote_min_chars) throw new EssenceError('quote_required', `No quote, no marker: quote is the exact sentence from their own words, at least ${RULE.quote_min_chars} characters.`);
  if (quote.length > RULE.quote_max_chars) throw new EssenceError('quote_too_long', `A quote is one sentence or two, ${RULE.quote_max_chars} characters at most.`);
  const source_kind = clean(i.source_kind, 40) as SourceKind;
  if (!SOURCE_KINDS.includes(source_kind)) throw new EssenceError('unknown_source_kind', `source_kind is one of: ${SOURCE_KINDS.join(', ')}.`);
  const source_ref = clean(i.source_ref, 500);
  if (!source_ref) throw new EssenceError('source_required', 'source_ref is the Codex Entry ID (codex_log) or the Slack link of the message (the other sources).');
  if (source_kind !== 'codex_log' && !parseLink(source_ref)) throw new EssenceError('source_required', `A ${source_kind} marker's source_ref is the Slack link (Copy link) of the message the quote is in.`);
  let confidence: number | null = null;
  if (i.confidence !== undefined && i.confidence !== null) {
    if (typeof i.confidence !== 'number' || !(i.confidence >= 0 && i.confidence <= 1)) throw new EssenceError('bad_confidence', 'confidence is a number from 0 to 1, or left out.');
    confidence = i.confidence;
  }
  const proposed_by = clean(i.proposed_by, 120) || 'unknown';
  return { subject_id, kind, line, quote, source_kind, source_ref, confidence, proposed_by, test: i.test === true };
}

/** Where a quote is checked. Stand-ins replace it in the tests. */
export interface SourceReader {
  codexLog(ref: string): Promise<{ found: false } | { found: true; builder: string | null; builder_name: string | null; transcript: string | null; entry_id: string }>;
  slackMessage(link: string): Promise<{ ok: true; user: string | null; text: string } | { ok: false; reason: 'not_found' | 'unreadable'; message: string }>;
}

export const liveReader: SourceReader = {
  async codexLog(ref) {
    const r = await query<{ builder: string | null; builder_name: string | null; transcript: string | null; entry_id: string | null; natural_id: string | null }>(
      `SELECT fields->>'Builder User ID' AS builder, fields->>'Builder Name' AS builder_name, fields->>'Transcript' AS transcript,
              fields->>'Codex Entry ID' AS entry_id, natural_id
         FROM engine_codex_submissions WHERE fields->>'Codex Entry ID' = $1 OR natural_id = $1 ORDER BY id DESC LIMIT 1`,
      [ref],
    );
    if (!r.rows.length) return { found: false };
    const x = r.rows[0];
    return { found: true, builder: x.builder, builder_name: x.builder_name, transcript: x.transcript, entry_id: x.entry_id ?? x.natural_id ?? ref };
  },
  async slackMessage(link) {
    const p = parseLink(link);
    if (!p) return { ok: false, reason: 'not_found', message: 'Not a Slack message link.' };
    const tokens: Array<string | undefined> = [];
    if (slack.slackConfigured()) tokens.push(undefined);
    const ns = slack.northStarToken();
    if (ns) tokens.push(ns);
    if (!tokens.length) return { ok: false, reason: 'unreadable', message: 'No Slack token is set, so the message cannot be read.' };
    const tried: string[] = [];
    for (const t of tokens) {
      const r = await slack.botCall('conversations.replies', { channel: p.channel, ts: p.thread_ts ?? p.ts, oldest: p.ts, latest: p.ts, inclusive: true, limit: 50 }, 'form', t);
      if (r.ok) {
        const m = ((r.messages as Array<{ ts?: string; user?: string; text?: string }>) ?? []).find((x) => x.ts === p.ts);
        if (!m) return { ok: false, reason: 'not_found', message: `Slack has no message ${p.ts} in ${p.channel}.` };
        return { ok: true, user: m.user ?? null, text: m.text ?? '' };
      }
      const error = String(r.error);
      if (error === 'thread_not_found' || error === 'message_not_found') return { ok: false, reason: 'not_found', message: `Slack has no message ${p.ts} in ${p.channel} (${error}).` };
      tried.push(error);
      if (!['missing_scope', 'not_in_channel', 'channel_not_found'].includes(error)) break;
    }
    return { ok: false, reason: 'unreadable', message: `Could not read ${p.channel} (${tried.join('; ')}).` };
  },
};

const toRow = (r: Record<string, unknown>): MarkerRow => ({
  marker_id: String(r.marker_id),
  subject_id: String(r.subject_id),
  subject_name: (r.subject_name as string) ?? null,
  kind: r.kind as Kind,
  line: String(r.line),
  quote: String(r.quote),
  source_kind: r.source_kind as SourceKind,
  source_ref: String(r.source_ref),
  seen_in: (r.seen_in as string[]) ?? [],
  status: r.status as Status,
  published: r.published === true,
  confidence: r.confidence === null || r.confidence === undefined ? null : Number(r.confidence),
  proposed_by: String(r.proposed_by),
  decided_by: (r.decided_by as string) ?? null,
  decided_at: r.decided_at instanceof Date ? r.decided_at.toISOString() : ((r.decided_at as string) ?? null),
  decision_note: (r.decision_note as string) ?? null,
  test: r.test === true,
  created_at: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
  updated_at: r.updated_at instanceof Date ? r.updated_at.toISOString() : String(r.updated_at),
});

function newId(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 4; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return `EM-${Date.now()}-${s}`;
}

async function profileName(id: string): Promise<string | null> {
  const r = await query<{ name: string | null }>(`SELECT fields->>'name' AS name FROM engine_builder_profiles WHERE natural_id = $1 LIMIT 1`, [id]).catch(() => ({ rows: [] as Array<{ name: string | null }> }));
  return r.rows[0]?.name ?? null;
}

export type ProposeResult =
  | { ok: true; outcome: 'proposed' | 'seen_again' | 'became_stable' | 'already_held'; written: boolean; marker: MarkerRow; message: string }
  | { ok: true; outcome: 'would_propose' | 'would_add_source'; written: false; marker: Partial<MarkerRow>; message: string };

/**
 * Proposes one marker. The quote is checked against its source first; a quote that is not there
 * is refused and nothing is written. A line already held for the person and kind adds this source
 * to it rather than a second row (and makes a confirmed one stable at three sources).
 */
export async function propose(input: ProposeInput, opts: { dry_run?: boolean; reader?: SourceReader; via?: string } = {}): Promise<ProposeResult> {
  const c = check(input);
  const reader = opts.reader ?? liveReader;
  let subject_name: string | null = null;
  if (c.source_kind === 'codex_log') {
    const log = await reader.codexLog(c.source_ref);
    if (!log.found) throw new EssenceError('source_not_found', `No Codex log is held with Codex Entry ID or Submission ID ${c.source_ref}.`);
    if (log.builder !== c.subject_id) throw new EssenceError('not_their_log', `${c.source_ref} is ${log.builder_name ?? log.builder ?? 'someone else'}'s log, not ${c.subject_id}'s. A marker comes from the person's own words.`);
    if (!log.transcript) throw new EssenceError('no_transcript', `${c.source_ref} carries no Transcript, so no quote can be checked. No quote, no marker.`);
    if (!quoteIn(c.quote, log.transcript)) throw new EssenceError('quote_not_found', `That quote is not in ${c.source_ref}'s narration, word for word. No quote, no marker: copy the sentence exactly as they said it.`);
    subject_name = log.builder_name;
    c.source_ref = log.entry_id;
  } else {
    const m = await reader.slackMessage(c.source_ref);
    if (!m.ok) throw new EssenceError(m.reason === 'not_found' ? 'source_not_found' : 'source_unreadable', `${m.message} No quote, no marker.`);
    if (m.user !== c.subject_id) throw new EssenceError('not_their_message', `That message was posted by ${m.user ?? 'a bot or an unknown sender'}, not ${c.subject_id}. A marker comes from the person's own words.`);
    if (!quoteIn(c.quote, m.text)) throw new EssenceError('quote_not_found', 'That quote is not in the linked message, word for word. No quote, no marker.');
  }
  subject_name = subject_name ?? (await profileName(c.subject_id));

  const held = await query(`SELECT * FROM engine_essence_markers WHERE subject_id = $1 AND kind = $2 AND test = $3`, [c.subject_id, c.kind, c.test]);
  const same = held.rows.map(toRow).find((m) => norm(m.line) === norm(c.line));
  if (same?.status === 'rejected') {
    throw new EssenceError('previously_rejected', `${subject_name ?? c.subject_id} said "Not me" to this marker (${same.marker_id}). It is not proposed again.`, { marker_id: same.marker_id });
  }
  if (!same) {
    const fromSource = await query<{ c: number }>(
      `SELECT count(*)::int AS c FROM engine_essence_markers WHERE subject_id = $1 AND test = $2 AND status <> 'rejected' AND $3 = ANY(seen_in)`,
      [c.subject_id, c.test, c.source_ref],
    );
    const count = fromSource.rows[0]?.c ?? 0;
    if (count >= RULE.max_per_source) {
      throw new EssenceError('too_many_for_source', `${c.source_ref} already holds ${count} markers for this person; at most ${RULE.max_per_source} per log or message.`);
    }
  }

  if (same) {
    if (same.seen_in.includes(c.source_ref)) return { ok: true, outcome: 'already_held', written: false, marker: same, message: `Already held as ${same.marker_id} from this source. Nothing changed.` };
    if (opts.dry_run) return { ok: true, outcome: 'would_add_source', written: false, marker: { ...same, seen_in: [...same.seen_in, c.source_ref] }, message: `Dry run: ${c.source_ref} would be added to ${same.marker_id}. Nothing was written.` };
    const seen = [...same.seen_in, c.source_ref];
    const stable = same.status === 'confirmed' && new Set(seen).size >= RULE.stable_at_sources;
    const status: Status = stable ? 'stable' : same.status;
    const row = await withTransaction(async (db) => {
      const u = await db.query(`UPDATE engine_essence_markers SET seen_in = $2, status = $3, updated_at = now() WHERE marker_id = $1 RETURNING *`, [same.marker_id, seen, status]);
      await record(
        { event_type: stable ? 'essence_marker_stable' : 'essence_marker_seen_again', subject_id: c.subject_id, lane: 'BAYS', actor: c.proposed_by, source_ref: c.source_ref, detail: { marker_id: same.marker_id, sources: seen.length, test: c.test }, dedupe_key: `essence:${same.marker_id}:${c.source_ref}` },
        db,
      );
      return toRow(u.rows[0]);
    });
    return { ok: true, outcome: stable ? 'became_stable' : 'seen_again', written: true, marker: row, message: stable ? `${row.marker_id} is now stable: confirmed and seen in ${seen.length} sources.` : `${c.source_ref} added to ${row.marker_id} (seen in ${seen.length}).` };
  }

  if (opts.dry_run) {
    return { ok: true, outcome: 'would_propose', written: false, marker: { ...c, subject_name, seen_in: [c.source_ref], status: 'proposed', published: false }, message: 'Dry run: the quote was found in its source and the marker would be proposed. Nothing was written.' };
  }
  const id = newId();
  const row = await withTransaction(async (db) => {
    const ins = await db.query(
      `INSERT INTO engine_essence_markers (marker_id, subject_id, subject_name, kind, line, quote, source_kind, source_ref, seen_in, confidence, proposed_by, via, test)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [id, c.subject_id, subject_name, c.kind, c.line, c.quote, c.source_kind, c.source_ref, [c.source_ref], c.confidence, c.proposed_by, opts.via ?? 'unknown', c.test],
    );
    await record(
      { event_type: 'essence_marker_proposed', subject_id: c.subject_id, lane: 'BAYS', actor: c.proposed_by, source_ref: c.source_ref, detail: { marker_id: id, kind: c.kind, source_kind: c.source_kind, test: c.test }, dedupe_key: `essence:${id}` },
      db,
    );
    return toRow(ins.rows[0]);
  });
  return { ok: true, outcome: 'proposed', written: true, marker: row, message: `Proposed ${row.marker_id} for ${subject_name ?? c.subject_id}. It feeds no twin until they confirm it.` };
}

/**
 * The person's own decision on their own marker. Only the subject may decide: nobody confirms,
 * rejects or publishes a marker for someone else.
 */
export async function decide(i: { marker_id: string; action: string; requester_user_id: string; note?: string | null; dry_run?: boolean }): Promise<{ ok: true; written: boolean; marker: MarkerRow; message: string }> {
  const action = clean(i.action, 20) as Action;
  if (!ACTIONS.includes(action)) throw new EssenceError('unknown_action', `action is one of: ${ACTIONS.join(', ')}.`);
  const r = await query(`SELECT * FROM engine_essence_markers WHERE marker_id = $1`, [clean(i.marker_id, 60)]);
  if (!r.rows.length) throw new EssenceError('not_found', `No marker ${i.marker_id}.`);
  const m = toRow(r.rows[0]);
  const who = slackId(i.requester_user_id);
  if (who !== m.subject_id) {
    throw new EssenceError('not_the_subject', `${m.marker_id} is about ${m.subject_name ?? m.subject_id}, and only they can say "That's me" or "Not me", or share it. Nobody decides it for them.`);
  }
  const note = clean(i.note, 1000) || null;
  let status = m.status;
  let published = m.published;
  if (action === 'confirm') {
    if (m.status !== 'proposed') throw new EssenceError('not_proposed', `${m.marker_id} is ${m.status}; only a proposed marker is confirmed.`);
    status = new Set(m.seen_in).size >= RULE.stable_at_sources ? 'stable' : 'confirmed';
  } else if (action === 'reject') {
    if (m.status === 'rejected') throw new EssenceError('already_rejected', `${m.marker_id} is already rejected.`);
    status = 'rejected';
    published = false;
  } else {
    if (m.status !== 'confirmed' && m.status !== 'stable') throw new EssenceError('not_confirmed', `Only a confirmed marker can be shared; ${m.marker_id} is ${m.status}.`);
    published = action === 'publish';
    if (published === m.published) throw new EssenceError('no_change', `${m.marker_id} is already ${published ? 'shared' : 'private'}.`);
  }
  const words = { confirm: '"That\'s me"', reject: '"Not me"', publish: 'shared', unpublish: 'made private again' }[action];
  if (i.dry_run) return { ok: true, written: false, marker: { ...m, status, published }, message: `Dry run: ${m.marker_id} would be ${words}. Nothing was written.` };
  const row = await withTransaction(async (db) => {
    const u = await db.query(
      `UPDATE engine_essence_markers SET status = $2, published = $3, decided_by = $4, decided_at = now(), decision_note = COALESCE($5, decision_note), updated_at = now() WHERE marker_id = $1 RETURNING *`,
      [m.marker_id, status, published, who, note],
    );
    await record({ event_type: `essence_marker_${action === 'unpublish' ? 'made_private' : action === 'publish' ? 'shared' : action === 'confirm' ? 'confirmed' : 'rejected'}`, subject_id: m.subject_id, lane: 'BAYS', actor: who, detail: { marker_id: m.marker_id, status, published, test: m.test } }, db);
    return toRow(u.rows[0]);
  });
  return { ok: true, written: true, marker: row, message: `${row.marker_id}: ${words}. Status ${row.status}${row.published ? ', shared' : ', private'}.` };
}

export interface EssenceRead {
  subject_id: string;
  subject_name: string | null;
  /** Confirmed and stable markers: the only ones a twin may use. */
  markers: Array<Pick<MarkerRow, 'marker_id' | 'kind' | 'line' | 'quote' | 'status' | 'published' | 'source_ref' | 'seen_in' | 'decided_at'>>;
  counts: Record<Status, number>;
  readiness: { stable_markers: number; confirmed_markers: number; last_confirmed_at: string | null };
  rules: string[];
}

/** Resolves a Slack id or a name to the person, from Builder Profiles and the markers held. */
export async function resolveSubject(who: string): Promise<{ id: string; name: string | null } | null> {
  const id = slackId(who);
  if (/^[UW][A-Z0-9]{6,}$/.test(id)) return { id, name: await profileName(id) };
  const n = norm(who);
  if (!n) return null;
  const r = await query<{ id: string; name: string | null }>(
    `SELECT natural_id AS id, fields->>'name' AS name FROM engine_builder_profiles WHERE lower(fields->>'name') = $1 OR lower(split_part(fields->>'name', ' ', 1)) = $1 LIMIT 2`,
    [n],
  ).catch(() => ({ rows: [] as Array<{ id: string; name: string | null }> }));
  if (r.rows.length === 1) return r.rows[0];
  const m = await query<{ id: string; name: string | null }>(`SELECT DISTINCT subject_id AS id, subject_name AS name FROM engine_essence_markers WHERE lower(subject_name) = $1 LIMIT 2`, [n]);
  return m.rows.length === 1 ? m.rows[0] : null;
}

export const READ_RULES = [
  'Only confirmed and stable markers are returned: a proposed marker is a draft the person has not agreed to, and a rejected one is a "Not me".',
  'Essence is private between the person and the engine. Do not quote a marker to anyone else unless published is true.',
  'A marker is how the person decides, with the sentence they said. Never extend it into a personality judgement.',
  'Markers never feed pay, Logstream or any score.',
];

/** What a twin reads. Never a proposed or rejected marker, never another person's by mistake. */
export async function read(subject_id: string, opts: { include_test?: boolean } = {}): Promise<EssenceRead> {
  const r = await query(`SELECT * FROM engine_essence_markers WHERE subject_id = $1 AND (test = false OR $2) ORDER BY (status = 'stable') DESC, decided_at DESC NULLS LAST`, [subject_id, opts.include_test === true]);
  const rows = r.rows.map(toRow);
  const counts: Record<Status, number> = { proposed: 0, confirmed: 0, rejected: 0, stable: 0 };
  for (const m of rows) counts[m.status] += 1;
  const usable = rows.filter((m) => m.status === 'confirmed' || m.status === 'stable');
  const last = usable.map((m) => m.decided_at).filter((d): d is string => !!d).sort().pop() ?? null;
  return {
    subject_id,
    subject_name: rows[0]?.subject_name ?? (await profileName(subject_id)),
    markers: usable.map((m) => ({ marker_id: m.marker_id, kind: m.kind, line: m.line, quote: m.quote, status: m.status, published: m.published, source_ref: m.source_ref, seen_in: m.seen_in, decided_at: m.decided_at })),
    counts,
    readiness: { stable_markers: counts.stable, confirmed_markers: counts.confirmed, last_confirmed_at: last },
    rules: READ_RULES,
  };
}
