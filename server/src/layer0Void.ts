/**
 * Voiding a parked log (25 Oct 2026, Destiny — Kaiqi in #bha-log-reviews,
 * 1792899253.224039).
 *
 * A log the completeness check parks waits on its builder in the Layer 0 table
 * (`engine_layer0_holds`, Status `pending_builder_input`) and is reminded every
 * six hours until it is filled in. Kaiqi parked a log for missing its
 * commercial note, then sent the corrected log as a new submission for the
 * same recording, which went through. The parked copy stayed, kept reminding
 * him, and nothing could close it: the table is read only over MCP and there
 * was no button. Bays then told him there was no newer submission, because it
 * only looked at the parked table.
 *
 * A void:
 *
 * - is the builder's own, or Jason's or Destiny's (`ADMIN_IDS`), and needs a
 *   written reason (3 to 1,000 characters);
 * - is refused for a parked log already completed (it went through to review,
 *   and it is that review's to decide) or already voided;
 * - writes Status `voided` and new fields — `Voided At`, `Voided By`,
 *   `Voided By Slack ID`, `Voided Reason`, `Replaced By`, `Status Before Void`
 *   — every other field kept. **The row stays on record**; nothing deletes it;
 * - **closes the row to the engine**: from then on every engine write to it is
 *   refused 409 `log_voided` (`guardVoided`), so an old form's Complete button
 *   cannot send it on, and no engine write may set Status `voided` itself
 *   (`use_void_path`);
 * - drops out of everything that reads `pending_builder_input` literally: the
 *   six-hourly reminder, `/log-status`, the Codex page's Needs input stage;
 * - replies in the "Log parked" thread in #bha-log-reviews, which is found by
 *   the row id that post prints, or, when there is none (since Q2VC an
 *   incomplete log goes to Jason's review card instead), in the review card's
 *   thread kept on the Codex row (`findReviewCard`); and tells the builder in their log channel
 *   when someone else voided it. A Slack post that does not land never undoes
 *   the void: the answer is `ok: false, raise: true`, naming it.
 *
 * **Auto-retire.** When a Codex log goes through (`engineWrite.postRecord`,
 * kind codex), any parked log for the same builder and the same recording
 * (the Session URL without its query string) under a different Submission ID
 * is voided "replaced by" the new one. Never able to fail that write.
 *
 * Three doors, one function: n8n's Void this log button
 * (`POST /api/engine/layer0/void`, `x-dashboard-key`), the MCP write tool
 * `void_parked_log` (in Bays' scope, so Bays can void one when asked in a
 * thread), and the auto-retire hook.
 */
import { query } from './pg';
import * as mirror from './mirror';
import * as slack from './slack';
import * as engineEvents from './engineEvents';
import { ADMIN_IDS } from './writeGuards';
import { SLACK_TO_BUILDER, LAYER0_PENDING } from './sources';

export const VOIDED = 'voided';
/** #bha-log-reviews, where `Notify Review Channel — Log Parked` posts. */
export const LOG_REVIEW_CHANNEL = process.env.LOG_REVIEW_CHANNEL?.trim() || 'C0AUKTND199';
const NAMES: Record<string, string> = { U0AEW3TBYH1: 'Destiny', U0A9V97949F: 'Jason' };
const AUTO_ACTOR = 'auto-retire';

export class VoidError extends Error {
  constructor(
    public reason: string,
    message: string,
    public status = 422,
  ) {
    super(message);
  }
}

interface HeldRow {
  id: string;
  submission_id: string | null;
  status: string | null;
  builder_user_id: string | null;
  builder_name: string | null;
  channel_id: string | null;
  session_url: string | null;
  description: string | null;
  missing: string | null;
  created_at: string | null;
  first_seen_at: string | null;
}

const SELECT = `SELECT id::text, fields->>'Submission ID' AS submission_id, fields->>'Status' AS status,
       fields->>'Builder User ID' AS builder_user_id, fields->>'Builder Username' AS builder_name,
       fields->>'Channel ID' AS channel_id, fields->>'Session URL' AS session_url,
       left(fields->>'Session Description', 300) AS description, fields->>'Missing Fields' AS missing,
       fields->>'Created At' AS created_at, first_seen_at
  FROM engine_layer0_holds`;

/** The recording a URL names, whatever tracking query it was pasted with. Exported for the test. */
export function recordingKey(url: string | null | undefined): string | null {
  const s = (url ?? '').trim();
  if (!s) return null;
  try {
    const u = new URL(s);
    return `${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, '')}`;
  } catch {
    return s.split(/[?#]/)[0].replace(/\/+$/, '').toLowerCase() || null;
  }
}

/** The parked row a reference names: this table's id or a Submission ID. Exactly one, or a refusal. */
export async function resolve(ref: string): Promise<HeldRow> {
  const v = ref.trim();
  if (!v) throw new VoidError('log_required', 'Send the parked log: its row id (the number on the "Log parked" post) or its Submission ID.');
  const r = await query<HeldRow>(`${SELECT} WHERE id::text = $1 OR natural_id = $1 OR fields->>'Submission ID' = $1 ORDER BY id`, [v]);
  if (!r.rows.length) throw new VoidError('not_found', `No parked log "${v}" is held. Send its row id or Submission ID.`, 404);
  if (r.rows.length > 1) throw new VoidError('ambiguous', `"${v}" names ${r.rows.length} parked logs (rows ${r.rows.map((x) => x.id).join(', ')}). Send the row id.`, 409);
  return r.rows[0];
}

/** Codex logs for the same builder and recording, other than this one: the likely replacements. */
export async function replacementsOf(row: HeldRow): Promise<{ submission_id: string; jason_status: string | null; logged_at: string | null }[]> {
  const key = recordingKey(row.session_url);
  if (!key || !row.builder_user_id) return [];
  const r = await query<{ submission_id: string; jason_status: string | null; logged_at: string | null; url: string | null }>(
    `SELECT fields->>'Submission ID' AS submission_id, fields->>'Jason Status' AS jason_status, fields->>'Timestamp' AS logged_at, fields->>'Session Url' AS url
       FROM engine_codex_submissions
      WHERE fields->>'Builder User ID' = $1 AND fields->>'Session Url' IS NOT NULL AND fields->>'Submission ID' IS NOT NULL
        AND fields->>'Submission ID' IS DISTINCT FROM $2
      ORDER BY id DESC LIMIT 200`,
    [row.builder_user_id, row.submission_id],
  );
  return r.rows.filter((x) => recordingKey(x.url) === key).map(({ url, ...rest }) => (void url, rest));
}

interface Posted {
  what: 'review_thread_reply' | 'builder_notice';
  channel: string;
  ts: string;
  ok: boolean;
  error?: string;
}

/**
 * The "Log parked" post for this row in #bha-log-reviews. It prints the row as
 * "*Row:* `18`", which is the only key it carries, so the channel is read from
 * just before the row was written. Bays' token first, North Star's where Bays
 * cannot read the channel. A channel that cannot be read is said.
 */
export async function findParkedPost(row: Pick<HeldRow, 'id' | 'created_at' | 'first_seen_at'>): Promise<{ ok: true; ts: string | null } | { ok: false; error: string }> {
  const when = Date.parse(row.created_at ?? '') || Date.parse(row.first_seen_at ?? '');
  const oldest = Number.isNaN(when) || !when ? '0' : String(Math.floor(when / 1000) - 300);
  const latest = Number.isNaN(when) || !when ? undefined : String(Math.floor(when / 1000) + 3600);
  const mine = (m: { text?: string; bot_id?: string; blocks?: unknown }) => {
    if (!m.bot_id) return false;
    const text = `${m.text ?? ''} ${JSON.stringify(m.blocks ?? '')}`;
    return /log parked/i.test(text) && text.includes(`\`${row.id}\``);
  };
  const tried: string[] = [];
  for (const [label, token] of [['Bays', undefined], ['North Star', slack.northStarToken()]] as const) {
    if (token === null) continue;
    let cursor: string | undefined;
    let error: string | null = null;
    for (let page = 0; page < 5; page++) {
      const r = await slack.botCall('conversations.history', { channel: LOG_REVIEW_CHANNEL, oldest, ...(latest ? { latest } : {}), limit: 200, cursor }, 'form', token);
      if (!r.ok) {
        error = String(r.error);
        break;
      }
      const hit = ((r.messages as { ts?: string; text?: string; bot_id?: string; blocks?: unknown }[]) ?? []).find((m) => m.ts && mine(m));
      if (hit?.ts) return { ok: true, ts: hit.ts };
      cursor = (r.response_metadata as { next_cursor?: string } | undefined)?.next_cursor || undefined;
      if (!cursor) break;
    }
    if (!error) return { ok: true, ts: null };
    tried.push(`${label}: ${error}`);
  }
  return { ok: false, error: `conversations.history could not read ${LOG_REVIEW_CHANNEL} (${tried.join('; ') || 'no Slack token'})` };
}

/**
 * Since Q2VC (30 Oct 2026) an incomplete log is not posted as "Log parked": it
 * goes to Jason's review card, marked incomplete, and the parked row and the
 * Codex row share one Submission ID. `Save Review Card Location · PATCH` keeps
 * the card's place on the Codex row (`Review Card Channel`, `Review Card TS`),
 * so a void replies in that card's thread when there is no "Log parked" post.
 */
export async function findReviewCard(submissionId: string | null): Promise<{ channel: string; ts: string } | null> {
  if (!submissionId) return null;
  const r = await query<{ channel: string | null; ts: string | null }>(
    `SELECT fields->>'Review Card Channel' AS channel, fields->>'Review Card TS' AS ts FROM engine_codex_submissions
      WHERE fields->>'Submission ID' = $1 AND fields->>'Review Card TS' IS NOT NULL ORDER BY id DESC LIMIT 1`,
    [submissionId],
  );
  const hit = r.rows[0];
  return hit?.ts ? { channel: hit.channel?.trim() || LOG_REVIEW_CHANNEL, ts: hit.ts } : null;
}

function dashboardUrl(): string {
  return (process.env.PUBLIC_DASHBOARD_URL || 'https://dashboard.bhanetwork.org').replace(/\/+$/, '');
}

export interface VoidInput {
  ref: string;
  /** The Slack id of the person voiding: the builder, Jason or Destiny. Null only on the auto-retire path. */
  requester_user_id: string | null;
  reason: string | null;
  /** The Submission ID of the log that replaces this one, when there is one. */
  replaced_by?: string | null;
  dry_run?: boolean;
  /** Who the write log names: `mcp:…`, `n8n:button`, `auto-retire`. */
  actor: string;
  /** Set only by `retireOnSubmission`. */
  auto?: boolean;
}

export async function voidLog(input: VoidInput) {
  const auto = input.auto === true;
  const requester = input.requester_user_id?.trim() || null;
  const reason = (input.reason ?? '').trim();
  if (!auto && !requester) throw new VoidError('who_is_required', 'Send requester_user_id: the Slack id of the person voiding it. The builder, Jason or Destiny can void a parked log.');
  if (reason.length < 3 || reason.length > 1000) throw new VoidError('reason_required', 'Write why it is being voided (3 to 1,000 characters). It is kept on the log and shown in the review thread.');

  const row = await resolve(input.ref);
  const isBuilder = Boolean(requester && row.builder_user_id && requester === row.builder_user_id);
  if (!auto && !isBuilder && !ADMIN_IDS.includes(requester as string)) {
    throw new VoidError('not_permitted', `Only the builder who sent it (${row.builder_user_id ?? 'unknown'}), Jason or Destiny can void this parked log.`, 403);
  }
  const status = (row.status ?? '').trim().toLowerCase();
  if (status === VOIDED) throw new VoidError('already_voided', `Parked log ${row.id} is already voided.`, 409);
  if (status === 'completed') {
    throw new VoidError('already_completed', `Parked log ${row.id} was completed and went on to review under ${row.submission_id ?? 'its Submission ID'}. A void is for a parked log that will never be completed; that one is the review's to decide.`, 409);
  }

  // The replacement: the one named, checked against the Codex, or the one the recording points to.
  const candidates = await replacementsOf(row);
  let replacedBy = input.replaced_by?.trim() || null;
  if (replacedBy) {
    const held = await query<{ n: string }>(`SELECT count(*)::text AS n FROM engine_codex_submissions WHERE fields->>'Submission ID' = $1`, [replacedBy]);
    if (held.rows[0]?.n === '0') throw new VoidError('replacement_not_found', `No Codex log has Submission ID ${replacedBy}. Send the replacement's Submission ID, or leave replaced_by out.`, 404);
    if (replacedBy === row.submission_id) throw new VoidError('replaced_by_itself', 'A log cannot be replaced by itself.', 422);
  } else if (candidates.length === 1) {
    replacedBy = candidates[0].submission_id;
  }

  const by = auto ? 'Bays (auto-retire)' : isBuilder ? (row.builder_name ?? (row.builder_user_id ? SLACK_TO_BUILDER[row.builder_user_id] : null) ?? 'the builder') : NAMES[requester as string];
  const plan = {
    row_id: row.id,
    submission_id: row.submission_id,
    builder: row.builder_user_id ? SLACK_TO_BUILDER[row.builder_user_id] ?? row.builder_name ?? row.builder_user_id : row.builder_name,
    builder_user_id: row.builder_user_id,
    session: row.description,
    session_url: row.session_url,
    missing: row.missing,
    status_before: row.status,
    voided_by: by,
    reason,
    replaced_by: replacedBy,
    same_recording_in_codex: candidates,
  };
  if (input.dry_run) return { ok: true, dry_run: true, voided: false, ...plan, note: 'Nothing was changed. Call again without dry_run to void it.' };

  const at = new Date().toISOString();
  const fields: Record<string, unknown> = {
    Status: VOIDED,
    'Status Before Void': row.status,
    'Voided At': at,
    'Voided By': by,
    'Voided By Slack ID': requester,
    'Voided Reason': reason,
    ...(replacedBy ? { 'Replaced By': replacedBy } : {}),
  };
  // Straight through the mirror, past the guard: this is the one path allowed to set it.
  const t0 = Date.now();
  const r = await mirror.patchFields('layer0', row.id, fields, 'engine');
  await mirror.logWrite({ endpoint: `void:${input.actor}`, kind: 'layer0', method: 'PATCH', key_label: auto ? 'auto-retire' : 'void', natural_id: row.submission_id ?? undefined, outcome: r.changed ? 'updated' : 'unchanged', detail: `voided by ${by}${replacedBy ? `, replaced by ${replacedBy}` : ''}: ${reason}`.slice(0, 500), ms: Date.now() - t0 });
  try {
    await engineEvents.record({ event_type: 'layer0_log_voided', subject_id: row.submission_id ?? `layer0:${row.id}`, actor: by, detail: { row_id: row.id, builder_user_id: row.builder_user_id, reason, replaced_by: replacedBy, auto }, dedupe_key: `layer0_void:${row.id}` });
  } catch (e) {
    console.error(`[layer0 void] ${row.id}: event not recorded: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Slack. Each outcome kept; none undoes the void.
  const done: Posted[] = [];
  const replacedLine = replacedBy ? `\n*Replaced by:* \`${replacedBy}\`` : '';
  const found = await findParkedPost(row);
  if (found.ok && found.ts) {
    const text = `:wastebasket: *Voided by ${by}.* This parked log is closed: no more reminders, and it will not go to Jason.\n*Why:* ${reason}${replacedLine}\nIt stays on record on the dashboard (${dashboardUrl()}/codex).`;
    const p = await slack.botCall('chat.postMessage', { channel: LOG_REVIEW_CHANNEL, thread_ts: found.ts, unfurl_links: false, unfurl_media: false, text });
    done.push({ what: 'review_thread_reply', channel: LOG_REVIEW_CHANNEL, ts: String(p.ts ?? found.ts), ok: p.ok, ...(p.ok ? {} : { error: String(p.error) }) });
  } else {
    // No "Log parked" post: since Q2VC the incomplete log sits on Jason's review card instead.
    let card: { channel: string; ts: string } | null = null;
    let cardError: string | null = null;
    try {
      card = await findReviewCard(row.submission_id);
    } catch (e) {
      cardError = e instanceof Error ? e.message : String(e);
    }
    if (card) {
      const text = `:wastebasket: *Voided by ${by}.* The parked copy of this log is closed: no more reminders, and it can no longer be completed. Any approval already given on this card stands.\n*Why:* ${reason}${replacedLine}\nIt stays on record on the dashboard (${dashboardUrl()}/codex).`;
      const p = await slack.botCall('chat.postMessage', { channel: card.channel, thread_ts: card.ts, unfurl_links: false, unfurl_media: false, text });
      done.push({ what: 'review_thread_reply', channel: card.channel, ts: String(p.ts ?? card.ts), ok: p.ok, ...(p.ok ? {} : { error: String(p.error) }) });
    } else {
      const parked = found.ok ? `no "Log parked" post for row ${row.id} was found in the channel` : found.error;
      done.push({ what: 'review_thread_reply', channel: LOG_REVIEW_CHANNEL, ts: '', ok: false, error: `${parked}, and ${cardError ? `the review card could not be looked up (${cardError})` : `no review card is saved for ${row.submission_id ?? `row ${row.id}`}`}` });
    }
  }
  // The builder is told in their log channel when someone else voided it.
  if (!auto && !isBuilder && row.builder_user_id) {
    if (row.channel_id) {
      const text = `:wastebasket: <@${row.builder_user_id}>, ${by} has voided one of your parked logs, so it will stop reminding you and needs nothing more from you.\n*Session:* ${row.description ?? row.submission_id ?? row.id}\n*Why:* ${reason}${replacedLine}`;
      const p = await slack.botCall('chat.postMessage', { channel: row.channel_id, unfurl_links: false, unfurl_media: false, text });
      done.push({ what: 'builder_notice', channel: row.channel_id, ts: String(p.ts ?? ''), ok: p.ok, ...(p.ok ? {} : { error: String(p.error) }) });
    } else {
      done.push({ what: 'builder_notice', channel: '(none)', ts: '', ok: false, error: 'the parked log names no Channel ID, so the builder could not be told' });
    }
  }
  const failed = done.filter((d) => !d.ok);
  if (failed.length) console.error(`[layer0 void] ${row.id}: ${failed.length} Slack post(s) did not land: ${failed.map((f) => `${f.what} ${f.error}`).join('; ')}`);

  return {
    ok: failed.length === 0,
    voided: true,
    ...plan,
    voided_at: at,
    posts: done,
    ...(failed.length ? { raise: true, message: `The log is voided and stays on record, but ${failed.length} Slack post(s) did not land: ${failed.map((f) => `${f.what} (${f.error})`).join(', ')}.` } : {}),
  };
}

/**
 * A voided parked log is closed to the engine. Called by every engine write to
 * the layer0 kind before it lands (engineWrite.postRecord / patchRecord).
 */
export async function guardVoided(by: { rowId?: string | null; submissionId?: string | null }, fields: Record<string, unknown> | null): Promise<void> {
  const incoming = fields && typeof fields.Status === 'string' ? fields.Status.trim().toLowerCase() : null;
  if (incoming === VOIDED) {
    throw new mirror.MirrorError('Status cannot be set to voided by an engine write (use_void_path): use void_parked_log, POST /api/engine/layer0/void or the Void this log button, which take the reason and tell the review thread.', 409);
  }
  if (!by.rowId && !by.submissionId) return;
  const r = await query<{ id: string; sub: string | null; by: string | null; replaced: string | null }>(
    `SELECT id::text, fields->>'Submission ID' AS sub, fields->>'Voided By' AS by, fields->>'Replaced By' AS replaced FROM engine_layer0_holds
      WHERE lower(fields->>'Status') = $3 AND (id::text = $1 OR natural_id = $2 OR fields->>'Submission ID' = $2) LIMIT 1`,
    [by.rowId ?? '', by.submissionId ?? '', VOIDED],
  );
  const hit = r.rows[0];
  if (hit) {
    throw new mirror.MirrorError(`Parked log ${hit.sub ?? hit.id} was voided${hit.by ? ` by ${hit.by}` : ''}${hit.replaced ? ` (replaced by ${hit.replaced})` : ''} and is closed (log_voided): it does not go to Jason, and nothing writes to it.`, 409);
  }
}

/**
 * Auto-retire: a Codex log went through, so a parked copy of the same recording
 * by the same builder is voided "replaced by" it. Never throws; the outcome is
 * logged on engine_writes either way.
 */
export async function retireOnSubmission(fields: Record<string, unknown> | null | undefined): Promise<{ retired: string[]; failed: { row_id: string; error: string }[] }> {
  const out = { retired: [] as string[], failed: [] as { row_id: string; error: string }[] };
  try {
    const f = fields ?? {};
    const sub = typeof f['Submission ID'] === 'string' ? f['Submission ID'].trim() : '';
    const who = typeof f['Builder User ID'] === 'string' ? f['Builder User ID'].trim() : '';
    const key = recordingKey(typeof f['Session Url'] === 'string' ? f['Session Url'] : null);
    if (!sub || !who || !key) return out;
    const r = await query<HeldRow>(`${SELECT} WHERE lower(coalesce(fields->>'Status', '')) = $1 AND fields->>'Builder User ID' = $2 AND fields->>'Submission ID' IS DISTINCT FROM $3`, [LAYER0_PENDING, who, sub]);
    for (const row of r.rows.filter((x) => recordingKey(x.session_url) === key)) {
      try {
        await voidLog({ ref: row.id, requester_user_id: null, reason: `A newer log for the same recording went through as ${sub}, so this parked copy was retired automatically.`, replaced_by: sub, actor: AUTO_ACTOR, auto: true });
        out.retired.push(row.id);
      } catch (e) {
        out.failed.push({ row_id: row.id, error: e instanceof Error ? e.message : String(e) });
      }
    }
    if (out.failed.length) {
      await mirror.logWrite({ endpoint: 'void:auto-retire', kind: 'layer0', method: 'PATCH', key_label: 'auto-retire', natural_id: sub, outcome: 'error', detail: `could not retire ${out.failed.map((x) => `row ${x.row_id}: ${x.error}`).join('; ')}`.slice(0, 500) });
    }
  } catch (e) {
    console.error(`[layer0 auto-retire] ${e instanceof Error ? e.message : String(e)}`);
  }
  return out;
}
