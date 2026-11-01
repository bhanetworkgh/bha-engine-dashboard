/**
 * Media Twin posts (2026-11-01, Destiny): the record of everything that moves through the
 * Media Twin. One row per draft: what it was written from, the branded card and its images,
 * the text for each platform, the claim check, Jason's decision per platform with his note,
 * the revision it replaced, the Slack card it went out on, and later what each platform
 * posted and how it did.
 *
 * The daily n8n workflow (Media Twin — Daily Draft) writes a draft here; the Media Twin
 * Front Door writes the Approve / Reject clicks. Nothing posts to a platform from here.
 *
 * The claim rules are Jason's Media Twin claim-gating v0 contract (30 Oct 2026, decision
 * watch DW-1793377285257-MH3I) and are held here, in code, so no path can skip them:
 *   - blocked: "sensor-driven irrigation" and "fully automated farm" (not true of vFarm yet).
 *     A blocked platform cannot be approved.
 *   - flagged: a number about how the farm performs or what it earns (yield, revenue, cost,
 *     a percentage, a price). Approvable, but marked for Jason.
 *   - clean: neither.
 * No publish without a claim check and a recorded approver. Only Jason or Destiny decide.
 *
 * `claimCheck()` is pure, so the rules are tested without a database.
 */
import { query, withTransaction, type Queryable } from './pg';
import { record } from './engineEvents';
import * as events from './events';

export const SCHEMA = 'media.post.v1';
export const JASON = 'U0A9V97949F';
export const DESTINY = 'U0AEW3TBYH1';
export const APPROVERS: Record<string, string> = { [JASON]: 'Jason', [DESTINY]: 'Destiny' };

export const PLATFORMS = ['linkedin', 'x', 'facebook', 'instagram'] as const;
export type Platform = (typeof PLATFORMS)[number];
export const OCCASIONS = ['build_update', 'new_month', 'holiday', 'trend', 'other'] as const;
export const DECISIONS = ['approve', 'reject'] as const;

/* ----------------------------------------------------------------- claim check */

/** Phrases that are not true of vFarm yet. A post carrying one cannot be approved. */
export const BLOCKED: { id: string; re: RegExp; why: string }[] = [
  { id: 'sensor_driven_irrigation', re: /sensor[\s-]*(driven|based|controlled|triggered)\s+(irrigation|watering)/i, why: 'vFarm does not have sensor-driven irrigation yet.' },
  { id: 'fully_automated_farm', re: /fully[\s-]*automat(ed|ic)\s+(vertical\s+)?(farm|farming|grow)/i, why: 'vFarm is not a fully automated farm.' },
];

/** Words that make a number a claim about how the farm performs or what it earns. */
const PERFORMANCE = /\b(yield|yields|harvest|harvests|revenue|profit|profits|margin|roi|return|returns|earn|earns|earning|income|cost|costs|cheaper|save|saves|saving|savings|faster|more|less|times|grow|grows|growth|output|water|energy|kg|kilo|kilos|lbs|pounds|tons|tonnes|per\s+(month|year|week|day|square|sq))\b/i;
const MONEY_OR_PCT = /[$€£₦]\s?\d|\d\s?(%|percent\b|x\b|×)/i;
const HAS_NUMBER = /\d/;

export interface ClaimFinding {
  status: 'blocked' | 'flagged';
  rule: string;
  text: string;
  why: string;
}

/** Splits text into sentences and lines, the unit a finding quotes. */
function sentences(text: string): string[] {
  return String(text || '')
    .split(/(?<=[.!?])\s+|\n+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

/** The claim check for one piece of text. Pure. */
export function claimCheck(text: string): { status: 'clean' | 'flagged' | 'blocked'; findings: ClaimFinding[] } {
  const findings: ClaimFinding[] = [];
  for (const b of BLOCKED) {
    const m = String(text || '').match(b.re);
    if (m) findings.push({ status: 'blocked', rule: b.id, text: m[0], why: b.why });
  }
  for (const s of sentences(text)) {
    if (MONEY_OR_PCT.test(s) || (HAS_NUMBER.test(s) && PERFORMANCE.test(s) && !/^\s*(day|part|step|week)\s*\d/i.test(s))) {
      findings.push({ status: 'flagged', rule: 'performance_or_revenue_number', text: s.slice(0, 300), why: 'A number about how the farm performs or what it earns: Jason checks it before it goes out.' });
    }
  }
  const status = findings.some((f) => f.status === 'blocked') ? 'blocked' : findings.length ? 'flagged' : 'clean';
  return { status, findings };
}

const worst = (a: string[]): 'clean' | 'flagged' | 'blocked' => (a.includes('blocked') ? 'blocked' : a.includes('flagged') ? 'flagged' : 'clean');

/* ----------------------------------------------------------------- shapes */

export interface PlatformDraft {
  text: string;
  thread: string[];
  publish_at: string | null;
  claim_check_status: 'clean' | 'flagged' | 'blocked';
  claim_findings: ClaimFinding[];
  decision: 'pending' | 'approved' | 'rejected';
  decided_by: string | null;
  decided_at: string | null;
  note: string | null;
  posted_id: string | null;
  posted_url: string | null;
  posted_at: string | null;
}

export interface MediaPost {
  post_id: string;
  run_date: string;
  occasion: string;
  occasion_label: string | null;
  angle: string | null;
  revision: number;
  parent_post_id: string | null;
  status: string;
  card: Record<string, unknown>;
  images: { platform: string; width: number; height: number; url: string }[];
  platforms: Partial<Record<Platform, PlatformDraft>>;
  claim_check_status: string;
  sources: Record<string, unknown>;
  drafted_by: string;
  slack_channel: string | null;
  slack_ts: string | null;
  test: boolean;
  created_at: string;
  updated_at: string;
}

export class MediaPostError extends Error {
  constructor(public status: number, public reason: string, message: string) {
    super(message);
  }
}
const refuse = (reason: string, message: string, status = 422): never => {
  throw new MediaPostError(status, reason, message);
};
const s = (v: unknown, max = 500): string | null => {
  if (v == null) return null;
  const t = String(v).trim();
  return t ? t.slice(0, max) : null;
};
const bare = (v: string | null) => (v ? v.replace(/^<@?([A-Z0-9]+)(\|[^>]*)?>$/, '$1') : v);

/** A post's overall status, from its platforms' decisions. */
export function statusOf(p: Pick<MediaPost, 'platforms'>, superseded = false): string {
  if (superseded) return 'superseded';
  const ds = Object.values(p.platforms).map((x) => x!.decision);
  if (!ds.length) return 'draft';
  if (ds.every((d) => d === 'approved')) return 'approved';
  if (ds.every((d) => d === 'rejected')) return 'rejected';
  if (ds.every((d) => d === 'pending')) return 'in_review';
  return 'partly_decided';
}

const newId = (now = Date.now()) => `MTP-${now}-${Math.random().toString(36).slice(2, 6).toUpperCase().padEnd(4, 'X')}`;

const COLS = `post_id, run_date, occasion, occasion_label, angle, revision, parent_post_id, status, card, images, platforms,
  claim_check_status, sources, drafted_by, slack_channel, slack_ts, test, created_at, updated_at`;

function show(r: Record<string, unknown>): MediaPost {
  const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v == null ? null : String(v));
  const day = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v ?? '').slice(0, 10));
  return { ...(r as unknown as MediaPost), run_date: day(r.run_date), created_at: iso(r.created_at)!, updated_at: iso(r.updated_at)! };
}

async function one(db: Queryable, id: string, lock = false): Promise<MediaPost | null> {
  const r = await db.query(`SELECT ${COLS} FROM engine_media_posts WHERE post_id = $1${lock ? ' FOR UPDATE' : ''}`, [id]);
  return r.rows[0] ? show(r.rows[0] as Record<string, unknown>) : null;
}

/* ----------------------------------------------------------------- create */

export interface CreateInput {
  run_date?: string | null;
  occasion?: string | null;
  occasion_label?: string | null;
  angle?: string | null;
  parent_post_id?: string | null;
  card?: Record<string, unknown> | null;
  platforms: Record<string, { text?: string; thread?: string[]; publish_at?: string | null }>;
  sources?: Record<string, unknown> | null;
  drafted_by?: string | null;
  test?: boolean;
  dry_run?: boolean;
}

/** Writes one draft with its claim check. A revision supersedes the draft it replaces. */
export async function create(input: CreateInput) {
  const occasion = s(input.occasion, 40) ?? 'build_update';
  if (!(OCCASIONS as readonly string[]).includes(occasion)) refuse('bad_value', `occasion must be one of ${OCCASIONS.join(', ')}.`);
  const runDate = s(input.run_date, 10) ?? new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(runDate)) refuse('bad_value', 'run_date must be YYYY-MM-DD.');
  const raw = input.platforms && typeof input.platforms === 'object' ? input.platforms : refuse('bad_value', 'platforms must be an object keyed by platform.');
  const unknown = Object.keys(raw).filter((k) => !(PLATFORMS as readonly string[]).includes(k));
  if (unknown.length) refuse('bad_value', `Unknown platform: ${unknown.join(', ')}. The platforms are ${PLATFORMS.join(', ')}.`);
  const card = (input.card && typeof input.card === 'object' ? input.card : {}) as Record<string, unknown>;
  const cardText = ['kicker', 'headline', 'sub', 'foot'].map((k) => String(card[k] ?? '')).join('\n');
  const cardCheck = claimCheck(cardText);

  const platforms: Partial<Record<Platform, PlatformDraft>> = {};
  for (const [k, v] of Object.entries(raw)) {
    const text = s(v?.text, 6000);
    if (!text) refuse('missing_field', `${k} has no text.`);
    const thread = Array.isArray(v?.thread) ? v!.thread!.map((t) => s(t, 400)).filter((t): t is string => Boolean(t)).slice(0, 12) : [];
    const check = claimCheck([text, ...thread].join('\n'));
    // The card goes out with every platform, so its findings count against each one.
    const findings = [...cardCheck.findings.map((f) => ({ ...f, text: `[card] ${f.text}` })), ...check.findings];
    platforms[k as Platform] = {
      text: text!,
      thread,
      publish_at: s(v?.publish_at, 40),
      claim_check_status: worst([cardCheck.status, check.status]),
      claim_findings: findings,
      decision: 'pending',
      decided_by: null,
      decided_at: null,
      note: null,
      posted_id: null,
      posted_url: null,
      posted_at: null,
    };
  }
  if (!Object.keys(platforms).length) refuse('missing_field', 'A draft needs text for at least one platform.');

  return withTransaction(async (db) => {
    const parentId = s(input.parent_post_id, 40);
    const parent = parentId ? await one(db, parentId, true) : null;
    if (parentId && !parent) refuse('not_found', `No Media Twin post ${parentId} to revise.`, 404);
    // A revision rewrites what Jason rejected. A platform he already approved, and that the rewrite does not
    // send again, is carried over with its approval, so he is not asked twice about text he passed.
    if (parent) {
      for (const [k, v] of Object.entries(parent.platforms)) {
        if (!platforms[k as Platform] && v && v.decision === 'approved') platforms[k as Platform] = { ...v };
      }
    }
    const overall = worst(Object.values(platforms).map((p) => p!.claim_check_status));
    const id = newId();
    const now = new Date().toISOString();
    const post: MediaPost = {
      post_id: id,
      run_date: parent?.run_date ?? runDate,
      occasion: parent?.occasion ?? occasion,
      occasion_label: s(input.occasion_label, 200) ?? parent?.occasion_label ?? null,
      angle: s(input.angle, 500),
      revision: parent ? parent.revision + 1 : 1,
      parent_post_id: parent?.post_id ?? null,
      status: statusOf({ platforms }),
      card,
      images: [],
      platforms,
      claim_check_status: overall,
      sources: (input.sources && typeof input.sources === 'object' ? input.sources : {}) as Record<string, unknown>,
      drafted_by: s(input.drafted_by, 80) ?? 'media_twin',
      slack_channel: null,
      slack_ts: null,
      test: parent ? parent.test : input.test === true,
      created_at: now,
      updated_at: now,
    };
    if (input.dry_run) return { ok: true, written: false, dry_run: true, post, message: `Dry run: ${overall} draft, nothing written.` };
    await db.query(
      `INSERT INTO engine_media_posts (post_id, run_date, occasion, occasion_label, angle, revision, parent_post_id, status, card, images, platforms,
         claim_check_status, sources, drafted_by, test)
       VALUES ($1,$2::date,$3,$4,$5,$6,$7,$8,$9::jsonb,'[]'::jsonb,$10::jsonb,$11,$12::jsonb,$13,$14)`,
      [id, post.run_date, post.occasion, post.occasion_label, post.angle, post.revision, post.parent_post_id, post.status, JSON.stringify(card), JSON.stringify(platforms), overall, JSON.stringify(post.sources), post.drafted_by, post.test],
    );
    if (parent) await db.query(`UPDATE engine_media_posts SET status = 'superseded', updated_at = now() WHERE post_id = $1`, [parent.post_id]);
    await record(
      { event_type: 'media_post_drafted', subject_id: id, lane: 'MEDIA', actor: post.drafted_by, source_ref: parent?.post_id ?? null, detail: { schema: SCHEMA, revision: post.revision, parent_post_id: post.parent_post_id, occasion: post.occasion, platforms: Object.keys(platforms), claim_check_status: overall, test: post.test } },
      db,
    );
    events.changed('media_posts', id, db);
    return { ok: true, written: true, dry_run: false, post, message: `${id} drafted (revision ${post.revision}, claim check ${overall}).` };
  });
}

/* ----------------------------------------------------------------- attach */

/** Adds what the workflow learns after the draft is saved: the rendered images and the Slack card. Nothing else. */
export async function attach(postId: string, input: { images?: unknown; slack_channel?: unknown; slack_ts?: unknown }) {
  return withTransaction(async (db) => {
    const before = await one(db, postId, true);
    if (!before) refuse('not_found', `No Media Twin post ${postId}.`, 404);
    let images = before!.images;
    if (input.images !== undefined) {
      if (!Array.isArray(input.images)) refuse('bad_value', 'images must be a list of {platform, width, height, url}.');
      images = (input.images as Record<string, unknown>[]).map((x) => ({ platform: String(x.platform ?? ''), width: Number(x.width) || 0, height: Number(x.height) || 0, url: String(x.url ?? '') }));
      if (images.some((x) => !/^https:\/\//.test(x.url))) refuse('bad_value', 'Every image needs an https url.');
    }
    const channel = input.slack_channel !== undefined ? s(input.slack_channel, 40) : before!.slack_channel;
    const ts = input.slack_ts !== undefined ? s(input.slack_ts, 40) : before!.slack_ts;
    await db.query(`UPDATE engine_media_posts SET images = $2::jsonb, slack_channel = $3, slack_ts = $4, updated_at = now() WHERE post_id = $1`, [postId, JSON.stringify(images), channel, ts]);
    events.changed('media_posts', postId, db);
    return { ok: true, post: { ...before!, images, slack_channel: channel, slack_ts: ts } };
  });
}

/* ----------------------------------------------------------------- decide */

export interface DecideInput {
  platform: string;
  decision: string;
  by: string;
  note?: string | null;
  via?: string;
}

/** Records Jason's (or Destiny's) Approve or Reject for one platform. Append-only history beside the row. */
export async function decide(postId: string, input: DecideInput) {
  const by = bare(s(input.by, 40));
  if (!by || !APPROVERS[by]) refuse('not_permitted', `Only Jason or Destiny decide on a Media Twin post${by ? `; ${by} is not one of them` : ''}.`, 403);
  const platform = s(input.platform, 20) as Platform;
  if (!(PLATFORMS as readonly string[]).includes(platform)) refuse('bad_value', `platform must be one of ${PLATFORMS.join(', ')}.`);
  const decision = s(input.decision, 10);
  if (!(DECISIONS as readonly string[]).includes(decision ?? '')) refuse('bad_value', 'decision must be approve or reject.');
  const note = s(input.note, 2000);
  if (decision === 'reject' && (!note || note.length < 3)) refuse('note_required', 'A reject needs a note saying what was wrong, so the Media Twin can rewrite it.');

  return withTransaction(async (db) => {
    const before = await one(db, postId, true);
    if (!before) refuse('not_found', `No Media Twin post ${postId}.`, 404);
    if (before!.status === 'superseded') refuse('superseded', `${postId} was replaced by a newer revision; decide on that one.`, 409);
    const p = before!.platforms[platform];
    if (!p) refuse('not_found', `${postId} has no ${platform} draft.`, 404);
    if (decision === 'approve' && p!.claim_check_status === 'blocked')
      refuse('claim_blocked', `The ${platform} draft carries a blocked claim (${p!.claim_findings.filter((f) => f.status === 'blocked').map((f) => f.text).join('; ')}), so it cannot be approved. Reject it with a note and the Media Twin will rewrite it.`);
    const now = new Date().toISOString();
    const nextPlatform: PlatformDraft = { ...p!, decision: decision === 'approve' ? 'approved' : 'rejected', decided_by: by, decided_at: now, note: note ?? p!.note };
    const platforms = { ...before!.platforms, [platform]: nextPlatform };
    const status = statusOf({ platforms });
    await db.query(`UPDATE engine_media_posts SET platforms = $2::jsonb, status = $3, updated_at = now() WHERE post_id = $1`, [postId, JSON.stringify(platforms), status]);
    await db.query(
      `INSERT INTO engine_media_post_decisions (post_id, platform, decision, decided_by, note, claim_check_status, via) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [postId, platform, decision, by, note, p!.claim_check_status, s(input.via, 60) ?? 'http'],
    );
    await record(
      { event_type: 'media_post_decided', subject_id: postId, lane: 'MEDIA', actor: by, source_ref: before!.slack_ts, detail: { schema: SCHEMA, platform, decision, note, claim_check_status: p!.claim_check_status, revision: before!.revision, test: before!.test } },
      db,
    );
    events.changed('media_posts', postId, db);
    return { ok: true, post: { ...before!, platforms, status }, decided: { platform, decision, by, by_name: APPROVERS[by!], note, at: now } };
  });
}

/* ----------------------------------------------------------------- metrics */

export async function addMetrics(postId: string, input: Record<string, unknown>) {
  const platform = s(input.platform, 20);
  if (!(PLATFORMS as readonly string[]).includes(platform ?? '')) refuse('bad_value', `platform must be one of ${PLATFORMS.join(', ')}.`);
  const n = (k: string) => (input[k] == null || input[k] === '' ? null : Number.isFinite(Number(input[k])) ? Math.round(Number(input[k])) : refuse('bad_value', `${k} must be a number.`));
  const exists = await query(`SELECT 1 FROM engine_media_posts WHERE post_id = $1`, [postId]);
  if (!exists.rows.length) refuse('not_found', `No Media Twin post ${postId}.`, 404);
  const r = await query<{ id: string }>(
    `INSERT INTO engine_media_post_metrics (post_id, platform, impressions, reach, likes, comments, shares, saves, clicks, raw)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb) RETURNING id::text`,
    [postId, platform, n('impressions'), n('reach'), n('likes'), n('comments'), n('shares'), n('saves'), n('clicks'), JSON.stringify(input.raw ?? {})],
  );
  events.changed('media_posts', postId);
  return { ok: true, metric_id: Number(r.rows[0].id) };
}

/* ----------------------------------------------------------------- read */

export async function read(input: { post_id?: string | null; status?: string | null; include_test?: boolean; limit?: number } = {}) {
  const where: string[] = [];
  const vals: unknown[] = [];
  const add = (sql: string, v: unknown) => {
    vals.push(v);
    where.push(sql.replace('?', `$${vals.length}`));
  };
  if (input.post_id) add('post_id = ?', input.post_id);
  if (input.status) add('status = ?', input.status);
  if (!input.include_test && !input.post_id) where.push('test = false');
  const limit = Math.min(Math.max(Number(input.limit) || 100, 1), 500);
  const r = await query(`SELECT ${COLS} FROM engine_media_posts ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT ${limit}`, vals);
  const posts = r.rows.map((x) => show(x as Record<string, unknown>));
  const ids = posts.map((p) => p.post_id);
  const hist = ids.length
    ? await query<{ post_id: string; platform: string; decision: string; decided_by: string; note: string | null; at: Date }>(
        `SELECT post_id, platform, decision, decided_by, note, at FROM engine_media_post_decisions WHERE post_id = ANY($1) ORDER BY at ASC`,
        [ids],
      )
    : { rows: [] };
  const met = ids.length
    ? await query(`SELECT DISTINCT ON (post_id, platform) post_id, platform, read_at, impressions, reach, likes, comments, shares, saves, clicks FROM engine_media_post_metrics WHERE post_id = ANY($1) ORDER BY post_id, platform, read_at DESC`, [ids])
    : { rows: [] };
  const c = await query<Record<string, string>>(
    `SELECT count(*) FILTER (WHERE NOT test)::text AS drafts,
            count(*) FILTER (WHERE NOT test AND status IN ('in_review','partly_decided'))::text AS waiting,
            count(*) FILTER (WHERE NOT test AND status = 'approved')::text AS approved,
            count(*) FILTER (WHERE NOT test AND status = 'rejected')::text AS rejected,
            count(*) FILTER (WHERE NOT test AND claim_check_status = 'blocked')::text AS blocked,
            count(*) FILTER (WHERE test)::text AS tests
       FROM engine_media_posts`,
  );
  const k = c.rows[0] ?? {};
  return {
    schema: SCHEMA,
    counts: { drafts: Number(k.drafts ?? 0), waiting_on_decision: Number(k.waiting ?? 0), approved: Number(k.approved ?? 0), rejected: Number(k.rejected ?? 0), blocked: Number(k.blocked ?? 0), test_drafts: Number(k.tests ?? 0) },
    posts: posts.map((p) => ({
      ...p,
      decisions: hist.rows.filter((h) => h.post_id === p.post_id).map((h) => ({ ...h, by_name: APPROVERS[h.decided_by] ?? h.decided_by, at: h.at instanceof Date ? h.at.toISOString() : String(h.at) })),
      metrics: (met.rows as Record<string, unknown>[]).filter((m) => m.post_id === p.post_id),
    })),
    rules: [
      'Blocked: "sensor-driven irrigation" and "fully automated farm" are not true of vFarm yet; a blocked platform cannot be approved.',
      'Flagged: a number about how the farm performs or what it earns; Jason checks it before approving.',
      'Only Jason or Destiny decide; a reject carries a note, and the Media Twin rewrites the draft from it as the next revision.',
      'Nothing is posted to a platform until posting is switched on; a decision here is the record that it may be.',
    ],
  };
}
