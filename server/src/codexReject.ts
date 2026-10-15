/**
 * Rejecting a Codex log (2026-10-15, Destiny).
 *
 * Jason, in Ahad's thread: "how this log can be rejected now that it's in
 * limbo". Ahad's log of 12 Oct had been sent back eight times and his last
 * answer was "I have covered them in yesterday log" — a newer log already
 * held what Jason had asked for. Approve, Add Input and Send Back all assume a
 * log will be accepted in the end; nothing said "this one will not be".
 *
 * A reject:
 *
 * - is Jason's or Destiny's alone (`ADMIN_IDS`), and needs a written reason;
 * - is refused for a log already Approved or Input Added, already rejected, or
 *   one that already has a Codex Entry ID — that log is in the Codex and owed
 *   pay, and taking it back is a different decision than this one;
 * - writes Jason Status `Rejected` with `Rejected At`, `Rejected By`,
 *   `Rejected By Slack ID` and `Rejected Reason` (new field names, nothing
 *   renamed), every other field kept — `store.rejectCodex`;
 * - **closes the row to the engine**: from then on every engine write to it is
 *   refused 409 (`guardRejected`), so a button pressed on an old card, or the
 *   pipeline running Layer 2 on a late answer, cannot put it into the Codex or
 *   into pay. The refusal is logged and n8n's node fails loudly, never quietly;
 * - **rewrites the Slack cards** the log left behind, as Bays: Jason's review
 *   card and every "sent back" message in the builder's channel, without their
 *   buttons, and posts one reply under the newest so the builder is told. A
 *   card that cannot be rewritten never undoes the reject; it comes back in
 *   `cards` with Slack's own error and the answer is not `ok`.
 *
 * Two doors, one function: the Codex entry's Reject button
 * (`POST /api/codex/:id/reject`) and the MCP write tool `reject_codex_log`.
 */
import { query } from './pg';
import * as store from './store';
import * as slack from './slack';
import * as mirror from './mirror';
import { ADMIN_IDS } from './writeGuards';
import { SLACK_TO_BUILDER } from './sources';

export class RejectError extends Error {
  constructor(
    public reason: string,
    message: string,
    public status = 422,
  ) {
    super(message);
  }
}

const NAMES: Record<string, string> = { U0AEW3TBYH1: 'Destiny', U0A9V97949F: 'Jason' };

interface HeldRow {
  id: string;
  /** The id the Codex page and the store use: Airtable's record id, else `row-<id>`. */
  record_id: string;
  submission_id: string | null;
  codex_entry_id: string | null;
  jason_status: string | null;
  builder_user_id: string | null;
  description: string | null;
}

/** The row a reference names: this table's id, a Submission ID or a Codex Entry ID. Exactly one, or a refusal. */
export async function resolve(ref: string): Promise<HeldRow> {
  const r = await query<HeldRow>(
    `SELECT id::text, coalesce(airtable_record_id, 'row-' || id) AS record_id, fields->>'Submission ID' AS submission_id, fields->>'Codex Entry ID' AS codex_entry_id,
            fields->>'Jason Status' AS jason_status, fields->>'Builder User ID' AS builder_user_id,
            left(fields->>'Session Description', 300) AS description
       FROM engine_codex_submissions
      WHERE id::text = $1 OR 'row-' || id = $1 OR airtable_record_id = $1 OR natural_id = $1 OR fields->>'Submission ID' = $1 OR fields->>'Codex Entry ID' = $1
      ORDER BY id`,
    [ref.trim()],
  );
  if (!r.rows.length) throw new RejectError('not_found', `No Codex log "${ref}" is held. Send its Submission ID, Codex Entry ID or row id.`, 404);
  if (r.rows.length > 1) throw new RejectError('ambiguous', `"${ref}" names ${r.rows.length} logs (rows ${r.rows.map((x) => x.id).join(', ')}). Send the row id.`, 409);
  return r.rows[0];
}

interface Card {
  what: 'review_card' | 'sent_back_message' | 'builder_reply';
  channel: string;
  ts: string;
  ok: boolean;
  error?: string;
}

/** Every Slack message this log's review left behind, read from its review rounds. */
async function cardsOf(submissionId: string): Promise<{ review: { channel: string; ts: string; blocks: unknown[] | null } | null; chasers: { channel: string; ts: string }[] }> {
  const r = await query<{ rc: string | null; rts: string | null; bc: string | null; cts: string | null; blocks: string | null; round: string | null }>(
    `SELECT fields->>'Review Channel ID' AS rc, fields->>'Review Message TS' AS rts,
            fields->>'Builder Channel ID' AS bc, fields->>'Chaser Message TS' AS cts,
            fields->>'Review Card Blocks' AS blocks, fields->>'Round' AS round
       FROM engine_review_returns WHERE fields->>'Submission ID' = $1
      ORDER BY (fields->>'Round')::int NULLS FIRST`,
    [submissionId],
  );
  let review: { channel: string; ts: string; blocks: unknown[] | null } | null = null;
  const chasers: { channel: string; ts: string }[] = [];
  for (const x of r.rows) {
    if (x.rc && x.rts) {
      let blocks: unknown[] | null = null;
      try {
        const p = x.blocks ? JSON.parse(x.blocks) : null;
        blocks = Array.isArray(p) ? p : null;
      } catch {
        blocks = null;
      }
      // The newest round's card is the one on screen; its blocks win.
      const prior: unknown[] | null = review ? (review as { blocks: unknown[] | null }).blocks : null;
      review = { channel: x.rc, ts: x.rts, blocks: blocks ?? prior };
    }
    if (x.bc && x.cts && !chasers.some((c) => c.ts === x.cts)) chasers.push({ channel: x.bc, ts: x.cts });
  }
  return { review, chasers };
}

function day(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

export interface RejectInput {
  ref: string;
  requester_user_id: string | null;
  reason: string | null;
  dry_run?: boolean;
  /** Who the record_writes line names: an email on the page, `mcp:…` over MCP. */
  actor: string;
}

export async function reject(input: RejectInput) {
  const requester = input.requester_user_id?.trim() || null;
  const reason = (input.reason ?? '').trim();
  if (!requester) throw new RejectError('who_is_required', 'Send requester_user_id: the Slack id of the person rejecting. Only Jason or Destiny can reject a log.');
  if (!ADMIN_IDS.includes(requester)) throw new RejectError('not_permitted', 'Only Jason or Destiny can reject a log.', 403);
  if (reason.length < 3 || reason.length > 1000) throw new RejectError('reason_required', 'Write why it is being rejected (3 to 1,000 characters). The builder is shown it.');

  const row = await resolve(input.ref);
  const status = (row.jason_status ?? '').trim().toLowerCase();
  if (status === 'rejected') throw new RejectError('already_rejected', `${row.submission_id ?? row.id} is already rejected.`, 409);
  if (status === 'approved' || status === 'input added') {
    throw new RejectError('already_approved', `${row.submission_id ?? row.id} is ${row.jason_status}: it has been dealt with. A reject is for a log that will never be approved.`, 409);
  }
  if (row.codex_entry_id) {
    throw new RejectError('in_codex', `${row.submission_id ?? row.id} already has Codex Entry ${row.codex_entry_id}, so it is in the Codex and counted for pay. Rejecting it would not take it out of either.`, 409);
  }

  const cards = row.submission_id ? await cardsOf(row.submission_id) : { review: null, chasers: [] };
  const by = NAMES[requester];
  const plan = {
    submission_id: row.submission_id,
    row_id: row.id,
    builder: row.builder_user_id ? SLACK_TO_BUILDER[row.builder_user_id] ?? row.builder_user_id : null,
    session: row.description,
    jason_status_before: row.jason_status,
    rejected_by: by,
    reason,
    cards_to_rewrite: [...(cards.review ? [{ what: 'review_card', channel: cards.review.channel, ts: cards.review.ts }] : []), ...cards.chasers.map((c) => ({ what: 'sent_back_message', ...c }))],
  };
  if (input.dry_run) return { ok: true, dry_run: true, rejected: false, ...plan, note: 'Nothing was changed. Call again without dry_run to reject it.' };

  const at = new Date().toISOString();
  const entry = await store.rejectCodex(row.record_id, { by_name: by, by_slack_id: requester, reason, at }, input.actor);

  // The cards. Each one rewritten without its buttons, each outcome kept.
  const done: Card[] = [];
  const headline = `:no_entry: *Rejected by ${by} on ${day(at)}.* This log will not go to the Codex and is not counted for pay.`;
  const why = `*Why:* ${reason}`;
  if (cards.review) {
    const kept = (cards.review.blocks ?? []).filter((b) => (b as { type?: string }).type !== 'actions');
    const blocks = [...kept, { type: 'divider' }, { type: 'section', text: { type: 'mrkdwn', text: `${headline}\n${why}` } }];
    const r = await slack.botCall('chat.update', { channel: cards.review.channel, ts: cards.review.ts, text: `Rejected by ${by}: ${reason}`, blocks });
    done.push({ what: 'review_card', channel: cards.review.channel, ts: cards.review.ts, ok: r.ok, ...(r.ok ? {} : { error: r.error }) });
  }
  const builderTag = row.builder_user_id ? `<@${row.builder_user_id}>` : 'The builder';
  for (const c of cards.chasers) {
    const text = `${headline}\n*Session:* ${row.description ?? row.submission_id ?? ''}\n${why}\nThere is nothing to send back on this log.`;
    const r = await slack.botCall('chat.update', { channel: c.channel, ts: c.ts, text: `Rejected by ${by}: ${reason}`, blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }] });
    done.push({ what: 'sent_back_message', channel: c.channel, ts: c.ts, ok: r.ok, ...(r.ok ? {} : { error: r.error }) });
  }
  const newest = cards.chasers[cards.chasers.length - 1];
  if (newest) {
    const r = await slack.botCall('chat.postMessage', {
      channel: newest.channel,
      thread_ts: newest.ts,
      unfurl_links: false,
      text: `${builderTag}, ${by} rejected this log: ${reason}\nIt will not go to the Codex and is not counted for pay. There is nothing more to do on it.`,
    });
    done.push({ what: 'builder_reply', channel: newest.channel, ts: String(r.ts ?? newest.ts), ok: r.ok, ...(r.ok ? {} : { error: r.error }) });
  }
  const failed = done.filter((d) => !d.ok);
  if (failed.length) console.error(`[codex reject] ${row.submission_id}: ${failed.length} Slack update(s) did not land: ${failed.map((f) => `${f.what} ${f.channel}/${f.ts} ${f.error}`).join('; ')}`);

  return {
    ok: failed.length === 0,
    rejected: true,
    ...plan,
    rejected_at: at,
    cards: done,
    ...(failed.length ? { raise: true, message: `The log is rejected, but ${failed.length} Slack message(s) were not rewritten and may still show buttons: ${failed.map((f) => `${f.what} (${f.error})`).join(', ')}.` } : {}),
    entry: { id: entry.id, stage: entry.stage, jason_status: entry.jason_status, rejected: entry.rejected },
  };
}

/**
 * A rejected log is closed to the engine. Called by every engine write to the
 * codex kind before it lands (engineWrite.postRecord / patchRecord): a write to
 * a rejected row is refused 409, and so is an engine write that tries to set
 * Jason Status to Rejected, which only `reject` sets.
 */
export async function guardRejected(by: { rowId?: string | null; submissionId?: string | null }, fields: Record<string, unknown> | null): Promise<void> {
  const incoming = fields && typeof fields['Jason Status'] === 'string' ? (fields['Jason Status'] as string).trim().toLowerCase() : null;
  if (incoming === 'rejected') {
    throw new mirror.MirrorError('Jason Status cannot be set to Rejected by an engine write (use_reject_path): use reject_codex_log or the Reject button on the Codex entry, which take the reason and tell the builder.', 409);
  }
  if (!by.rowId && !by.submissionId) return;
  const r = await query<{ id: string; sub: string | null; by: string | null }>(
    `SELECT id::text, fields->>'Submission ID' AS sub, fields->>'Rejected By' AS by FROM engine_codex_submissions
      WHERE lower(fields->>'Jason Status') = 'rejected' AND (id::text = $1 OR natural_id = $2 OR fields->>'Submission ID' = $2) LIMIT 1`,
    [by.rowId ?? '', by.submissionId ?? ''],
  );
  const hit = r.rows[0];
  if (hit) {
    throw new mirror.MirrorError(`Log ${hit.sub ?? hit.id} was rejected${hit.by ? ` by ${hit.by}` : ''} and is closed (log_rejected): it does not go to the Codex or into pay, and nothing writes to it.`, 409);
  }
}
