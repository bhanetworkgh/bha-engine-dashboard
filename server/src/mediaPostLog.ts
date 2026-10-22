/**
 * The Media Twin post log (2026-10-22, Destiny — H58Q, Jason's SOURCE_TO_TARGET_LOG).
 *
 * One row per post of one vFarm picture to one place: the source it came from,
 * the picture and its version, the platform, the claim it carries, the
 * approval, the tracked link, what happened when it went out, and the live
 * post's link or the error. Hardik's draft envelopes, Bays and Media Twin all
 * write here, so the engine has one answer to "which picture went where, and
 * was it allowed to".
 *
 * Pictures live in one place: the "Approved vFarm renders" Drive folder
 * (APPROVED_RENDERS_FOLDER), the only folder bhanetwork.org and /vfarm pull
 * from. A post can be queued or published only from a file in that folder.
 *
 * The rules are Jason's (#bha-coordination, 1792559349.662489) and are held
 * here, in code, on every path (HTTP, MCP, Bays):
 *   - Nothing is VERIFIED_CURRENT yet: classification stays CONCEPTUAL and
 *     verified_current_p1_0 stays false until the Canon/provenance bundle
 *     lands. Approval never flips it.
 *   - Manual only: automation_enabled true is refused.
 *   - Only Jason approves publication (APPROVE_FOR_EA_PUBLICATION), per asset.
 *   - Queued or published needs that approval, the picture in the approved
 *     folder, and a /vfarm link tagged for the platform (the brand kit's UTM).
 *   - Published needs the live post's own link or id. No identifier is ever
 *     made up here: every id on a row is one a person or a platform gave.
 *
 * `check()` is pure, so the rules are tested without a database or Drive.
 */
import { query, withTransaction, type Queryable } from './pg';
import { record } from './engineEvents';
import * as google from './google';
import * as events from './events';

export const SCHEMA = 'media.post_log.v1';
export const APPROVED_RENDERS_FOLDER = '19vTXax0Fk1JXSt3oHCcHBa3KonflqqPr';
export const JASON = 'U0A9V97949F';

export const PLATFORMS = ['linkedin', 'instagram', 'facebook', 'tiktok', 'x', 'website'] as const;
export const CLASSIFICATIONS = ['CONCEPTUAL', 'VERIFIED_CURRENT'] as const;
export const APPROVALS = ['pending', 'APPROVE_FOR_EA_PUBLICATION', 'REVISE', 'HOLD'] as const;
export const RESULTS = ['not_published', 'queued', 'published', 'failed', 'held'] as const;
export const READ_BACKS = ['not_checked', 'ok', 'error'] as const;

/** Fields a person may send. The rest (log_id, times, schema) are the engine's. */
export const FIELDS = [
  'asset_id', 'asset_version', 'asset_file_id', 'source_id', 'platform', 'classification', 'verified_current_p1_0',
  'claim_state', 'approval', 'approved_by', 'approved_at', 'automation_enabled', 'utm_url', 'publish_result',
  'target_url', 'target_id', 'read_back', 'read_back_detail', 'loop_id', 'notes',
] as const;
type Field = (typeof FIELDS)[number];

/** Set once on create; a different picture, source or platform is a new row. */
export const FIXED_AFTER_CREATE: Field[] = ['asset_id', 'asset_version', 'source_id', 'platform'];

export interface PostRow {
  log_id: string;
  asset_id: string;
  asset_version: string;
  asset_file_id: string | null;
  source_id: string;
  platform: string;
  classification: string;
  verified_current_p1_0: boolean;
  claim_state: string;
  approval: string;
  approved_by: string | null;
  approved_at: string | null;
  manual_only: boolean;
  automation_enabled: boolean;
  utm_url: string | null;
  publish_result: string;
  target_url: string | null;
  target_id: string | null;
  read_back: string;
  read_back_detail: string | null;
  loop_id: string | null;
  notes: string | null;
  logged_by: string;
  test: boolean;
  created_at: string;
  updated_at: string;
}

export class MediaPostLogError extends Error {
  constructor(public status: number, public reason: string, message: string, public extra: Record<string, unknown> = {}) {
    super(message);
  }
}

const refuse = (reason: string, message: string, extra: Record<string, unknown> = {}, status = 422): never => {
  throw new MediaPostLogError(status, reason, message, extra);
};

const s = (v: unknown, max = 500): string | null => {
  if (v == null) return null;
  if (typeof v !== 'string') return String(v).slice(0, max);
  const t = v.trim();
  return t ? t.slice(0, max) : null;
};
const bare = (v: string | null) => (v ? v.replace(/^<@?([A-Z0-9]+)(\|[^>]*)?>$/, '$1') : v);

/**
 * The link must be bhanetwork.org/vfarm with utm_source = the platform,
 * utm_medium = social and a utm_campaign, as the brand kit and the /vfarm form
 * expect. Returns why it is wrong, or null.
 */
export function utmProblem(link: string, platform: string): string | null {
  let u: URL;
  try {
    u = new URL(link);
  } catch {
    return `"${link}" is not a link.`;
  }
  const host = u.hostname.replace(/^www\./, '');
  if (host !== 'bhanetwork.org' || !/^\/vfarm\/?$/.test(u.pathname)) return `the link must go to bhanetwork.org/vfarm, not ${u.hostname}${u.pathname}.`;
  const src = u.searchParams.get('utm_source');
  if (src !== platform) return `utm_source must be "${platform}" for a ${platform} post, not ${src ? `"${src}"` : 'missing'}.`;
  if (u.searchParams.get('utm_medium') !== 'social') return 'utm_medium must be "social".';
  if (!u.searchParams.get('utm_campaign')) return 'utm_campaign is missing.';
  return null;
}

export interface CheckInput {
  before: PostRow | null;
  fields: Record<string, unknown>;
  /** Whether asset_file_id sits in the approved renders folder: true, false, or a reason Drive could not say. */
  inApprovedFolder?: (fileId: string) => Promise<true | false | string>;
}

/** Validates one create or update and returns the row as it would be. Pure apart from the folder check it is handed. */
export async function check({ before, fields, inApprovedFolder }: CheckInput): Promise<Omit<PostRow, 'log_id' | 'logged_by' | 'test' | 'created_at' | 'updated_at'>> {
  const unknown = Object.keys(fields).filter((k) => !(FIELDS as readonly string[]).includes(k));
  if (unknown.length) refuse('unknown_field', `Not a post log field: ${unknown.join(', ')}. The fields are ${FIELDS.join(', ')}.`, { unknown });

  if (before) {
    const moved = FIXED_AFTER_CREATE.filter((k) => k in fields && s(fields[k]) !== (before as unknown as Record<string, unknown>)[k]);
    if (moved.length) refuse('fixed_after_create', `${moved.join(', ')} cannot change on ${before.log_id}: a different picture, source or platform is a new row.`, { fields: moved });
  }

  const pick = <T>(k: Field, fallback: T): T | unknown => (k in fields ? fields[k] : before ? (before as unknown as Record<string, unknown>)[k] : fallback);

  const row = {
    asset_id: s(pick('asset_id', null), 80),
    asset_version: s(pick('asset_version', null), 40),
    asset_file_id: s(pick('asset_file_id', null), 200),
    source_id: s(pick('source_id', null), 300),
    platform: s(pick('platform', null), 20),
    classification: s(pick('classification', 'CONCEPTUAL'), 40) ?? 'CONCEPTUAL',
    verified_current_p1_0: pick('verified_current_p1_0', false) === true,
    claim_state: s(pick('claim_state', null), 80),
    approval: s(pick('approval', 'pending'), 40) ?? 'pending',
    approved_by: bare(s(pick('approved_by', null), 40)),
    approved_at: s(pick('approved_at', null), 40),
    manual_only: true,
    automation_enabled: pick('automation_enabled', false) === true,
    utm_url: s(pick('utm_url', null), 1000),
    publish_result: s(pick('publish_result', 'not_published'), 20) ?? 'not_published',
    target_url: s(pick('target_url', null), 1000),
    target_id: s(pick('target_id', null), 300),
    read_back: s(pick('read_back', 'not_checked'), 20) ?? 'not_checked',
    read_back_detail: s(pick('read_back_detail', null), 2000),
    loop_id: s(pick('loop_id', null), 80),
    notes: s(pick('notes', null), 2000),
  };

  const missing = (['asset_id', 'asset_version', 'source_id', 'platform', 'claim_state'] as const).filter((k) => !row[k]);
  if (missing.length) refuse('missing_field', `${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} required. Send the ids a person or the platform gave; nothing is made up here.`, { missing });

  if (!(PLATFORMS as readonly string[]).includes(row.platform!)) refuse('bad_value', `platform must be one of ${PLATFORMS.join(', ')}.`);
  if (!(CLASSIFICATIONS as readonly string[]).includes(row.classification)) refuse('bad_value', `classification must be one of ${CLASSIFICATIONS.join(', ')}.`);
  if (!(APPROVALS as readonly string[]).includes(row.approval)) refuse('bad_value', `approval must be one of ${APPROVALS.join(', ')}.`);
  if (!(RESULTS as readonly string[]).includes(row.publish_result)) refuse('bad_value', `publish_result must be one of ${RESULTS.join(', ')}.`);
  if (!(READ_BACKS as readonly string[]).includes(row.read_back)) refuse('bad_value', `read_back must be one of ${READ_BACKS.join(', ')}.`);
  if (row.approved_at && Number.isNaN(new Date(row.approved_at).getTime())) refuse('bad_value', 'approved_at must be an ISO 8601 time.');

  if (row.classification === 'VERIFIED_CURRENT' || row.verified_current_p1_0)
    refuse('verified_current_blocked', 'Nothing may be logged as verified current P1.0 hardware yet: verified-current imagery stays blocked on the Canon/provenance bundle, and an approval never flips it (Jason, H58Q). Log it as CONCEPTUAL with verified_current_p1_0 false.');
  if (row.automation_enabled) refuse('automation_off', 'Posts are manual only. automation_enabled true is refused; no automation or paid CTA is authorised (Jason, H58Q).');

  if (row.approval === 'APPROVE_FOR_EA_PUBLICATION' && row.approved_by !== JASON)
    refuse('approval_is_jasons', `Only Jason (${JASON}) approves a picture for publication. approved_by ${row.approved_by ? `"${row.approved_by}"` : 'is missing'}.`);

  if (before && before.publish_result === 'published' && row.publish_result !== 'published')
    refuse('already_published', `${before.log_id} is already published. A post that came down is a new row with its own result, so the record of where it went stays true.`);

  // Checked when a post moves out, or when what it goes out with changes. A later read-back
  // update on a post already out is not re-judged: a picture pulled from the folder since
  // must not stop the record of where it went from being kept true.
  const goingOut = row.publish_result === 'queued' || row.publish_result === 'published';
  const outChanged = !before || before.publish_result !== row.publish_result || ['asset_file_id', 'utm_url', 'approval', 'approved_by'].some((k) => k in fields);
  if (goingOut && outChanged) {
    if (row.approval !== 'APPROVE_FOR_EA_PUBLICATION')
      refuse('not_approved', `A post can be ${row.publish_result} only after Jason's APPROVE_FOR_EA_PUBLICATION for this picture; approval is ${row.approval}.`);
    if (!row.asset_file_id) refuse('asset_not_in_folder', 'asset_file_id is required to queue or publish: the Drive file of the approved picture.');
    if (row.platform !== 'website') {
      if (!row.utm_url) refuse('utm_required', `utm_url is required for a ${row.platform} post: bhanetwork.org/vfarm?utm_source=${row.platform}&utm_medium=social&utm_campaign=vfarm_early_access.`);
      const why = utmProblem(row.utm_url!, row.platform!);
      if (why) refuse('utm_wrong', `The tracked link is wrong: ${why}`);
    }
    if (!inApprovedFolder) refuse('drive_unchecked', 'The picture could not be checked against the approved renders folder, so nothing was written.', {}, 503);
    const where = await inApprovedFolder!(row.asset_file_id!);
    if (where !== true)
      refuse(
        where === false ? 'asset_not_in_folder' : 'drive_unchecked',
        where === false
          ? `The picture ${row.asset_file_id} is not in the "Approved vFarm renders" folder (${APPROVED_RENDERS_FOLDER}), the one place bhanetwork.org and /vfarm pull from. Put the approved file there first.`
          : `Drive could not say whether ${row.asset_file_id} is in the approved renders folder: ${where}. Nothing was written.`,
        {},
        where === false ? 422 : 503,
      );
  }
  if (row.publish_result === 'published' && !row.target_url && !row.target_id)
    refuse('target_required', 'A published post needs the live post\'s own link (target_url) or id (target_id), as the platform gave it.');
  if (row.read_back === 'error' && !row.read_back_detail) refuse('missing_field', 'read_back error needs read_back_detail: what the platform answered.');

  return row as Omit<PostRow, 'log_id' | 'logged_by' | 'test' | 'created_at' | 'updated_at'>;
}

/**
 * The real folder check, against Drive with this server's Google credential. A file in
 * the folder (not trashed) is true; elsewhere is false; Drive not configured or not
 * answering is a reason, which `check` turns into a refusal: fail closed.
 */
export async function inApprovedFolder(fileId: string): Promise<true | false | string> {
  if (!google.googleConfigured()) return google.notConfiguredMessage();
  try {
    const f = await google.fileParents(fileId);
    return !f.trashed && f.parents.includes(APPROVED_RENDERS_FOLDER);
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

const newId = (now = Date.now()) => `MPL-${now}-${Math.random().toString(36).slice(2, 6).toUpperCase().padEnd(4, 'X')}`;

const COLS = `log_id, asset_id, asset_version, asset_file_id, source_id, platform, classification, verified_current_p1_0, claim_state,
  approval, approved_by, approved_at, manual_only, automation_enabled, utm_url, publish_result, target_url, target_id,
  read_back, read_back_detail, loop_id, notes, logged_by, test, created_at, updated_at`;

function show(r: Record<string, unknown>): PostRow {
  const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v == null ? null : String(v));
  return { ...(r as unknown as PostRow), approved_at: iso(r.approved_at), created_at: iso(r.created_at)!, updated_at: iso(r.updated_at)! };
}

async function one(db: Queryable, logId: string): Promise<PostRow | null> {
  const r = await db.query(`SELECT ${COLS} FROM engine_media_post_log WHERE log_id = $1 FOR UPDATE`, [logId]);
  return r.rows[0] ? show(r.rows[0] as Record<string, unknown>) : null;
}

export interface WriteInput {
  log_id?: string | null;
  fields: Record<string, unknown>;
  by: string;
  via: string;
  test?: boolean;
  dry_run?: boolean;
  inApprovedFolder?: CheckInput['inApprovedFolder'];
}

export interface WriteResult {
  ok: true;
  schema: typeof SCHEMA;
  written: boolean;
  created: boolean;
  dry_run: boolean;
  row: PostRow;
  event_id: number | null;
  message: string;
}

/** Creates (no log_id) or updates one row, with its engine event, in one transaction. */
export async function write(input: WriteInput): Promise<WriteResult> {
  const by = bare(s(input.by, 40));
  if (!by) refuse('missing_field', 'Name who is logging this (a Slack id): every row names its author.');
  const fields = input.fields && typeof input.fields === 'object' && !Array.isArray(input.fields) ? input.fields : refuse('bad_value', 'fields must be an object.');
  const dry = input.dry_run === true;

  return withTransaction(async (db) => {
    const logId = s(input.log_id, 40);
    const before = logId ? await one(db, logId) : null;
    if (logId && !before) refuse('not_found', `No post log row ${logId}.`, {}, 404);
    const row = await check({ before, fields, inApprovedFolder: input.inApprovedFolder });
    const id = before?.log_id ?? newId();
    const test = before ? before.test : input.test === true;
    const now = new Date().toISOString();
    const out: PostRow = { log_id: id, ...row, logged_by: before?.logged_by ?? by!, test, created_at: before?.created_at ?? now, updated_at: now };

    const changed = before ? Object.keys(row).filter((k) => JSON.stringify((row as Record<string, unknown>)[k]) !== JSON.stringify((before as unknown as Record<string, unknown>)[k])) : Object.keys(row);
    if (before && changed.length === 0) return { ok: true, schema: SCHEMA, written: false, created: false, dry_run: dry, row: before, event_id: null, message: `${id}: nothing changed.` };
    if (dry) return { ok: true, schema: SCHEMA, written: false, created: !before, dry_run: true, row: out, event_id: null, message: `Dry run: ${before ? `${id} would be updated (${changed.join(', ')})` : 'a new row would be written'}. Nothing was written.` };

    const vals = [id, row.asset_id, row.asset_version, row.asset_file_id, row.source_id, row.platform, row.classification, row.verified_current_p1_0, row.claim_state,
      row.approval, row.approved_by, row.approved_at, row.manual_only, row.automation_enabled, row.utm_url, row.publish_result, row.target_url, row.target_id,
      row.read_back, row.read_back_detail, row.loop_id, row.notes, out.logged_by, test];
    if (before) {
      await db.query(
        `UPDATE engine_media_post_log SET asset_file_id=$2, classification=$3, verified_current_p1_0=$4, claim_state=$5, approval=$6, approved_by=$7,
           approved_at=$8::timestamptz, automation_enabled=$9, utm_url=$10, publish_result=$11, target_url=$12, target_id=$13,
           read_back=$14, read_back_detail=$15, loop_id=$16, notes=$17, updated_at=now()
         WHERE log_id=$1`,
        [id, row.asset_file_id, row.classification, row.verified_current_p1_0, row.claim_state, row.approval, row.approved_by,
          row.approved_at, row.automation_enabled, row.utm_url, row.publish_result, row.target_url, row.target_id,
          row.read_back, row.read_back_detail, row.loop_id, row.notes],
      );
    } else {
      await db.query(`INSERT INTO engine_media_post_log (${COLS.replace(/, created_at, updated_at$/, '')}) VALUES (${vals.map((_, i) => `$${i + 1}`).join(', ')})`, vals);
    }
    const ev = await record(
      {
        event_type: before ? 'media_post_updated' : 'media_post_logged',
        subject_id: id,
        lane: 'MEDIA',
        actor: by,
        source_ref: row.target_url ?? row.source_id,
        detail: { schema: SCHEMA, via: input.via, test, changed, asset_id: row.asset_id, asset_version: row.asset_version, platform: row.platform, approval: row.approval, publish_result: row.publish_result, read_back: row.read_back },
      },
      db,
    );
    events.changed('media_post_log', id, db);
    return { ok: true, schema: SCHEMA, written: true, created: !before, dry_run: false, row: out, event_id: ev.id, message: `${id} ${before ? `updated (${changed.join(', ')})` : 'logged'}${test ? ' as a test row' : ''}.` };
  });
}

export interface ReadInput {
  asset_id?: string | null;
  platform?: string | null;
  log_id?: string | null;
  include_test?: boolean;
  limit?: number;
}

/** Every row, newest first, with counts; test rows only when asked for, and always labelled. */
export async function read(input: ReadInput = {}) {
  const where: string[] = [];
  const vals: unknown[] = [];
  const add = (sql: string, v: unknown) => {
    vals.push(v);
    where.push(sql.replace('?', `$${vals.length}`));
  };
  if (input.log_id) add('log_id = ?', input.log_id);
  if (input.asset_id) add('asset_id = ?', input.asset_id);
  if (input.platform) add('platform = ?', input.platform);
  if (!input.include_test) where.push('test = false');
  const limit = Math.min(Math.max(Number(input.limit) || 100, 1), 500);
  const r = await query(`SELECT ${COLS} FROM engine_media_post_log ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT ${limit}`, vals);
  const c = await query<{ total: string; published: string; queued: string; awaiting: string; tests: string }>(
    `SELECT count(*) FILTER (WHERE NOT test)::text AS total,
            count(*) FILTER (WHERE NOT test AND publish_result = 'published')::text AS published,
            count(*) FILTER (WHERE NOT test AND publish_result = 'queued')::text AS queued,
            count(*) FILTER (WHERE NOT test AND approval = 'pending')::text AS awaiting,
            count(*) FILTER (WHERE test)::text AS tests
       FROM engine_media_post_log`,
  );
  const k = c.rows[0];
  return {
    schema: SCHEMA,
    approved_renders_folder: { id: APPROVED_RENDERS_FOLDER, url: `https://drive.google.com/drive/folders/${APPROVED_RENDERS_FOLDER}` },
    counts: { rows: Number(k?.total ?? 0), published: Number(k?.published ?? 0), queued: Number(k?.queued ?? 0), awaiting_approval: Number(k?.awaiting ?? 0), test_rows: Number(k?.tests ?? 0) },
    rows: r.rows.map((x) => show(x as Record<string, unknown>)),
    rules: [
      'CONCEPTUAL only: verified_current_p1_0 stays false until the Canon/provenance bundle lands; approval never flips it.',
      'Manual only: automation_enabled is always false.',
      'Only Jason approves publication (APPROVE_FOR_EA_PUBLICATION), per picture.',
      'Queued or published needs that approval, the file in the Approved vFarm renders folder, and a /vfarm link tagged for the platform.',
      'Published needs the live post\'s own link or id; no identifier is made up.',
    ],
  };
}
