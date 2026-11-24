/**
 * The Media Twin's second review and automatic posting (24 Nov 2026, Destiny — Jason in #bha-media-twin,
 * 1795485826.492839: "I want the system to make misses hard"; his rule the same evening, 1795544611.144079:
 * autonomous posting is a plan until there is a logged, working implementation, with a second reviewer, tagged
 * links and every live post logged the same day with its link and UTC time).
 *
 * The flow, run by n8n's Media Twin — Second Review after each draft and each rewrite is saved:
 *   1. Every platform still waiting is read by a second reviewer: a model given the rules below, the draft, its own
 *      claim and doctrine checks, and the last three posts that went live on that platform.
 *   2. All pass: each platform's bhanetwork.org links are tagged for that platform, it is approved by the reviewer
 *      (decided_by `media-twin-reviewer`, via `second_review`) and posts through the same path an Approve click
 *      uses. One message in #bha-media-twin opens the day's log; each live link and its UTC time is said under it.
 *   3. A fail on a platform that has not failed before: the reviewer rejects it with its reasons as the note, the
 *      platforms that passed are approved and post, and n8n runs Media Twin — Rewrite Draft from those notes. The
 *      rewrite comes back here.
 *   4. A fail on a platform that failed once already, or that a person rejected: nothing is decided, and n8n posts
 *      that platform's Approve / Reject card, tagging Jason and Destiny, with the reviewer's reasons on it.
 * A review that cannot run, or a draft while posting is paused, posts nothing and goes to the cards: no post ever
 * goes out unreviewed. The claim rules and the doctrine check still run inside the approval itself.
 *
 * The pause (`media_twin.autopost_paused` in meta) is Jason's or Destiny's alone: `set_media_autopost`, or
 * POST /api/engine/media-autopost.
 */
import { query, withTransaction } from './pg';
import { getMeta, setMeta } from './db';
import { record } from './engineEvents';
import * as events from './events';
import * as slack from './slack';
import * as posts from './mediaPosts';
import type { MediaPost, Platform } from './mediaPosts';

export const REVIEWER = posts.REVIEWER_ID;
export const PAUSE_KEY = 'media_twin.autopost_paused';
export const CHANNEL = process.env.MEDIA_TWIN_CHANNEL?.trim() || 'C0AFR4BH9UH';
/** A TEST draft's log goes to #bha-builder-sandbox, never the team channel (Destiny's standing rule). */
export const TEST_CHANNEL = process.env.MEDIA_TWIN_TEST_CHANNEL?.trim() || 'C0ATTFED35E';
const MODEL_TIMEOUT_MS = 60_000;

/** The reviewer's rules, word for word what the model is shown. Jason's rails (24 Nov 2026) and the v2 plan's four rules. */
export const RULES: { id: string; rule: string }[] = [
  { id: 'no_buying', rule: 'Nothing about buying, prices, charging, deposits, paying, pre-orders, discounts or ads. No dollar amounts and no "$199". The only ask allowed is joining vFarm Early Access.' },
  { id: 'one_soft_ask', rule: 'At most one call to action, and it is a soft Early Access ask. No pressure, no urgency, no scarcity.' },
  { id: 'no_live_monitoring', rule: 'No promise or claim that vFarm monitoring is live, real time, always on, 24/7 or watching your farm today. Monitoring is described as in development or being tested.' },
  { id: 'stage1_from_record', rule: 'Any Stage 1, hardware or test result is stated only as far as the draft\'s own sources show it. No invented results, numbers, dates or customers.' },
  { id: 'problem_with_fix', rule: 'Every problem the post mentions is paired with what is being done about it, with equal weight. No problem left hanging.' },
  { id: 'something_new', rule: 'It says something new compared with the last three posts on this platform: not the same story, hook or wording again.' },
  { id: 'no_internal_terms', rule: 'No internal names or jargon a buyer would not know: no loop or record ids, workflow names, agent names (Bays, Genie, North Star, Research Twin, Codex, BHARAG, n8n) and no builder named without their say.' },
  { id: 'fits_platform', rule: 'It reads well on this platform: clear, engaging, in plain words, the length the platform suits, and in the brand voice (direct, warm, confident, never hype).' },
];

/* ------------------------------------------------------------------ pure parts */

const clip = (v: unknown, n: number) => { const t = String(v ?? ''); return t.length > n ? t.slice(0, n - 1) + '…' : t; };

/**
 * Pure: tags every bhanetwork.org link in a post for the platform it goes out on, so sign-ups can be traced to the
 * post and the platform. A link already carrying utm_source is left as it is, and an email address is not a link.
 * Trailing punctuation stays outside.
 */
export function tagLinks(text: string, platform: string, postId: string): string {
  return String(text).replace(/(?<![@\w.\/-])(https?:\/\/)?((?:[a-z0-9-]+\.)*bhanetwork\.org)(?![\w-])(\/[^\s<>"')\]]*)?/gi, (whole, scheme: string | undefined, host: string, rest: string | undefined) => {
    let path = rest ?? '';
    const trail = path.match(/[.,!?;:]+$/)?.[0] ?? '';
    if (trail) path = path.slice(0, -trail.length);
    if (/[?&]utm_source=/i.test(path)) return whole;
    const [beforeHash, hash] = path.split('#');
    const base = beforeHash || '/';
    const sep = base.includes('?') ? '&' : '?';
    const tags = `utm_source=${encodeURIComponent(platform)}&utm_medium=social&utm_campaign=media_twin&utm_content=${encodeURIComponent(postId)}`;
    return `${scheme ?? 'https://'}${host}${base}${sep}${tags}${hash !== undefined ? '#' + hash : ''}${trail}`;
  });
}

export interface PlatformVerdict { pass: boolean; failed: string[]; reasons: string; fix: string }

/** Pure: the reviewer's answer, or null when it is not the JSON asked for. A platform missing from it fails. */
export function parseReview(text: string, platforms: string[]): Record<string, PlatformVerdict> | null {
  const raw = String(text ?? '');
  const candidates = [raw.trim(), raw.replace(/^```(?:json)?\s*|\s*```$/g, '').trim(), raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)];
  for (const c of candidates) {
    try {
      const j = JSON.parse(c) as { platforms?: Record<string, Record<string, unknown>> };
      if (!j || typeof j !== 'object' || !j.platforms || typeof j.platforms !== 'object') continue;
      const ids = new Set(RULES.map((r) => r.id));
      const out: Record<string, PlatformVerdict> = {};
      for (const k of platforms) {
        const v = j.platforms[k];
        if (!v || typeof v.pass !== 'boolean') { out[k] = { pass: false, failed: [], reasons: 'The reviewer gave no verdict for this platform.', fix: '' }; continue; }
        const failed = (Array.isArray(v.failed) ? v.failed : []).map(String).filter((x) => ids.has(x));
        out[k] = { pass: v.pass === true && failed.length === 0, failed, reasons: clip(v.reasons, 1200), fix: clip(v.fix, 1200) };
        if (v.pass === true && failed.length) out[k].reasons = out[k].reasons || `Marked pass but named failed rules: ${failed.join(', ')}.`;
      }
      return out;
    } catch {
      /* next */
    }
  }
  return null;
}

export type Step = 'post' | 'rewrite' | 'people';

/**
 * Pure: what happens next. All passed: post. Some failed and none of them failed or was rejected before in this
 * draft's history: the reviewer rejects them and the Media Twin rewrites. Otherwise: a person.
 */
export function nextStep(verdicts: Record<string, PlatformVerdict>, rejectedBefore: Set<string>): Step {
  const failed = Object.entries(verdicts).filter(([, v]) => !v.pass).map(([k]) => k);
  if (!failed.length) return 'post';
  return failed.some((k) => rejectedBefore.has(k)) ? 'people' : 'rewrite';
}

export function note(v: PlatformVerdict): string {
  return clip(`Second review: ${v.reasons}${v.failed.length ? ` (rules: ${v.failed.join(', ')})` : ''}${v.fix ? ` Fix: ${v.fix}` : ''}`, 2000);
}

const SYSTEM = [
  'You are the second reviewer for BHA\'s Media Twin, which posts once a day for vFarm, a home vertical farm cabinet in development, to win vFarm Early Access sign-ups.',
  'For each platform you are given, decide whether the post can go out as it is. Pass it only if it keeps every rule. Be strict on the rules and fair on taste: do not fail a post for style alone when it keeps the rules and reads well.',
  'Rules:',
  ...RULES.map((r) => `- ${r.id}: ${r.rule}`),
  'Answer with JSON only, no prose around it: {"platforms": {"<platform>": {"pass": true|false, "failed": ["<rule id>", ...], "reasons": "<one or two plain sentences: what is wrong, quoting the words>", "fix": "<what to change, plainly>"}}}. For a pass, failed is [] and fix is "".',
].join('\n');

/* ------------------------------------------------------------------ the model */

async function askReviewer(user: string): Promise<{ text: string | null; provider: string | null; error: string | null }> {
  const errors: string[] = [];
  const routes = [
    { provider: 'anthropic', key: process.env.ANTHROPIC_API_KEY?.trim(), url: `${(process.env.ANTHROPIC_API_URL || 'https://api.anthropic.com/v1').replace(/\/+$/, '')}/messages` },
    { provider: 'openrouter', key: process.env.OPENROUTER_API_KEY?.trim(), url: `${(process.env.OPENROUTER_API_URL || 'https://openrouter.ai/api/v1').replace(/\/+$/, '')}/chat/completions` },
  ];
  for (const r of routes) {
    if (!r.key) { errors.push(`${r.provider}: not configured`); continue; }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), MODEL_TIMEOUT_MS);
    try {
      const anthropic = r.provider === 'anthropic';
      const res = await fetch(r.url, {
        method: 'POST',
        headers: anthropic ? { 'x-api-key': r.key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' } : { Authorization: `Bearer ${r.key}`, 'content-type': 'application/json', 'X-Title': 'BHA Engine Dashboard - Media Twin second review' },
        body: JSON.stringify(
          anthropic
            ? { model: 'claude-sonnet-5-5', max_tokens: 2000, system: SYSTEM, messages: [{ role: 'user', content: user }] }
            : { model: 'anthropic/claude-sonnet-5.5', max_tokens: 2000, messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: user }] },
        ),
        signal: controller.signal,
      });
      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok || json.error) throw new Error(`HTTP ${res.status}: ${clip((json.error as { message?: string })?.message ?? json.error ?? '', 200)}`);
      const text = anthropic
        ? ((json.content as { type?: string; text?: string }[]) || []).filter((b) => b.type === 'text').map((b) => b.text || '').join('')
        : String(((json.choices as { message?: { content?: string } }[]) || [])[0]?.message?.content ?? '');
      if (!text.trim()) throw new Error('empty answer');
      return { text, provider: r.provider, error: null };
    } catch (e) {
      errors.push(`${r.provider}: ${e instanceof Error ? (e.name === 'AbortError' ? 'timed out' : e.message) : String(e)}`);
    } finally {
      clearTimeout(timer);
    }
  }
  return { text: null, provider: null, error: errors.join('; ') };
}

/* ------------------------------------------------------------------ the pause */

export async function pauseState(): Promise<{ paused: boolean; by: string | null; at: string | null; reason: string | null }> {
  const raw = await getMeta(PAUSE_KEY);
  try {
    const j = raw ? (JSON.parse(raw) as { paused?: boolean; by?: string; at?: string; reason?: string }) : {};
    return { paused: j.paused === true, by: j.by ?? null, at: j.at ?? null, reason: j.reason ?? null };
  } catch {
    return { paused: false, by: null, at: null, reason: null };
  }
}

export async function setPaused(input: { paused?: unknown; by?: unknown; reason?: unknown; dry_run?: unknown }) {
  const by = String(input.by ?? '').trim().replace(/^<@?([A-Z0-9]+)(\|[^>]*)?>$/, '$1');
  if (!posts.APPROVERS[by]) throw new posts.MediaPostError(403, 'not_permitted', 'Only Jason or Destiny pause or resume Media Twin posting.');
  if (typeof input.paused !== 'boolean') throw new posts.MediaPostError(422, 'bad_value', 'paused must be true or false.');
  const reason = String(input.reason ?? '').trim();
  if (reason.length < 3) throw new posts.MediaPostError(422, 'reason_required', 'Say why, in a few words.');
  const before = await pauseState();
  const after = { paused: input.paused, by, at: new Date().toISOString(), reason: reason.slice(0, 500) };
  if (input.dry_run === true) return { ok: true, dry_run: true, before, after };
  await setMeta(PAUSE_KEY, JSON.stringify(after));
  await record({ event_type: input.paused ? 'media_autopost_paused' : 'media_autopost_resumed', subject_id: 'media_twin', lane: 'MEDIA', actor: by, detail: { reason: after.reason, before } });
  return { ok: true, before, after: { ...after, by_name: posts.APPROVERS[by] } };
}

/* ------------------------------------------------------------------ the review */

async function lineage(post: MediaPost): Promise<MediaPost[]> {
  const out: MediaPost[] = [];
  let parent = post.parent_post_id;
  for (let i = 0; parent && i < 10; i++) {
    const p = (await posts.read({ post_id: parent, include_test: true })).posts[0];
    if (!p) break;
    out.push(p);
    parent = p.parent_post_id;
  }
  return out;
}

async function lastLive(platform: Platform, exclude: string[]): Promise<string[]> {
  const r = await query<{ text: string }>(
    `SELECT platforms -> $1 ->> 'text' AS text FROM engine_media_posts
      WHERE NOT test AND platforms -> $1 ->> 'posted_url' IS NOT NULL AND NOT (post_id = ANY($2::text[]))
      ORDER BY platforms -> $1 ->> 'posted_at' DESC NULLS LAST LIMIT 3`,
    [platform, exclude],
  );
  return r.rows.map((x) => x.text).filter(Boolean);
}

function reviewMessage(post: MediaPost, keys: Platform[], recent: Record<string, string[]>): string {
  const L: Record<string, string> = { linkedin: 'LinkedIn', x: 'X', facebook: 'Facebook', instagram: 'Instagram' };
  const lines = [
    `Draft ${post.post_id} for ${post.run_date} (${post.occasion_label || post.occasion}). Angle: ${post.angle || '(none)'}.`,
    `Card: ${JSON.stringify(post.card)}`,
    `The draft's sources: ${clip(JSON.stringify(post.sources ?? {}), 3000)}`,
    '',
  ];
  for (const k of keys) {
    const d = post.platforms[k]!;
    lines.push(`=== ${k} (${L[k]})`);
    lines.push(d.thread?.length ? [d.text, ...d.thread].map((t, i) => `[${i + 1}] ${t}`).join('\n') : d.text);
    lines.push(`Claim check: ${d.claim_check_status}${d.claim_findings?.length ? ' ' + d.claim_findings.map((f) => `${f.status}: "${f.text}"`).join(' | ') : ''}`);
    const doc = post.doctrine?.platforms?.[k];
    if (doc) lines.push(`Doctrine check: dust-collector contrast ${doc.dust_collector}, appliance ${doc.appliance}${doc.note ? ', ' + doc.note : ''}`);
    lines.push(`The last posts that went live on ${L[k]}, newest first:`);
    lines.push(...(recent[k]?.length ? recent[k].map((t, i) => `(${i + 1}) ${clip(t, 1500)}`) : ['(none yet)']));
    lines.push('');
  }
  lines.push(`Review these platforms: ${keys.join(', ')}. Answer with the JSON object only.`);
  return lines.join('\n');
}

async function storeReviews(postId: string, verdicts: Record<string, PlatformVerdict>, meta: { round: number; provider: string | null; error: string | null; step: Step | 'unreviewed' }) {
  const at = new Date().toISOString();
  await withTransaction(async (db) => {
    const r = await db.query<{ platforms: MediaPost['platforms']; slack_ts: string | null; test: boolean }>(`SELECT platforms, slack_ts, test FROM engine_media_posts WHERE post_id = $1 FOR UPDATE`, [postId]);
    const platforms = { ...(r.rows[0]?.platforms ?? {}) } as Record<string, Record<string, unknown>>;
    for (const [k, v] of Object.entries(verdicts)) {
      if (!platforms[k]) continue;
      const history = Array.isArray(platforms[k].reviews) ? (platforms[k].reviews as unknown[]) : [];
      const entry = { at, round: meta.round, ...v, provider: meta.provider, error: meta.error, step: meta.step };
      platforms[k] = { ...platforms[k], review: entry, reviews: [...history, entry] };
    }
    await db.query(`UPDATE engine_media_posts SET platforms = $2::jsonb, updated_at = now() WHERE post_id = $1`, [postId, JSON.stringify(platforms)]);
    await record({ event_type: 'media_post_reviewed', subject_id: postId, lane: 'MEDIA', actor: REVIEWER, source_ref: r.rows[0]?.slack_ts ?? null, detail: { round: meta.round, step: meta.step, provider: meta.provider, error: meta.error, verdicts, test: r.rows[0]?.test ?? false } }, db);
    events.changed('media_posts', postId, db);
  });
}

/** Tags a passing platform's links on the stored words before it is approved, so what posts is what is held. */
async function tagStored(postId: string, k: Platform) {
  await withTransaction(async (db) => {
    const r = await db.query<{ platforms: MediaPost['platforms'] }>(`SELECT platforms FROM engine_media_posts WHERE post_id = $1 FOR UPDATE`, [postId]);
    const platforms = { ...(r.rows[0]?.platforms ?? {}) };
    const d = platforms[k];
    if (!d || d.decision !== 'pending') return;
    const text = tagLinks(d.text, k, postId);
    const thread = (d.thread ?? []).map((t) => tagLinks(t, k, postId));
    if (text === d.text && thread.every((t, i) => t === d.thread[i])) return;
    platforms[k] = { ...d, text, thread, links_tagged: true } as typeof d;
    await db.query(`UPDATE engine_media_posts SET platforms = $2::jsonb, updated_at = now() WHERE post_id = $1`, [postId, JSON.stringify(platforms)]);
  });
}

/** The thread the day's live links are said in: the post's own, else the draft it rewrote, else a new message. */
async function ensureLogThread(post: MediaPost, chain: MediaPost[]): Promise<{ channel: string; ts: string } | null> {
  if (post.slack_channel && post.slack_ts) return { channel: post.slack_channel, ts: post.slack_ts };
  const inherited = chain.find((p) => p.slack_channel && p.slack_ts);
  let at = inherited ? { channel: inherited.slack_channel!, ts: inherited.slack_ts! } : null;
  if (!at) {
    const headline = String(post.card?.headline ?? '').replace(/\*/g, '');
    const r = await slack.botCall('chat.postMessage', {
      channel: post.test ? TEST_CHANNEL : CHANNEL,
      text: `${post.test ? 'TEST · ' : ''}Media Twin, ${post.run_date}: today's post passed the second review and is going out on its own. "${clip(headline, 140)}" (${post.post_id}). Each live link and its time in UTC follows in this thread.`,
      unfurl_links: false,
    });
    if (!r.ok || !r.ts) {
      await record({ event_type: 'media_post_log_not_posted', subject_id: post.post_id, lane: 'MEDIA', actor: REVIEWER, detail: { error: String(r.error ?? 'no ts') } }).catch(() => undefined);
      return null;
    }
    at = { channel: String(r.channel ?? (post.test ? TEST_CHANNEL : CHANNEL)), ts: String(r.ts) };
  }
  await posts.attach(post.post_id, { slack_channel: at.channel, slack_ts: at.ts });
  return at;
}

export interface ReviewOutcome {
  ok: true;
  post_id: string;
  next: 'done' | 'cards' | 'rewrite' | 'people';
  why: string;
  paused: boolean;
  round: number;
  reviewed: Record<string, PlatformVerdict>;
  approved: string[];
  rejected: string[];
  people: { platform: string; reasons: string }[];
  log_thread: { channel: string; ts: string } | null;
}

/**
 * Reviews every platform of a draft still waiting, and acts on the verdict. Never posts a platform the reviewer did
 * not pass, and never posts anything while paused or when the review could not run.
 */
export async function review(postId: string): Promise<ReviewOutcome> {
  const post = (await posts.read({ post_id: postId, include_test: true })).posts[0];
  if (!post) throw new posts.MediaPostError(404, 'not_found', `No Media Twin post ${postId}.`);
  if (post.status === 'superseded') throw new posts.MediaPostError(409, 'superseded', `${postId} was replaced by a newer revision; review that one.`);
  const keys = posts.PLATFORMS.filter((k) => post.platforms[k]?.decision === 'pending');
  const chain = await lineage(post);
  const round = chain.length + 1;
  const base = { ok: true as const, post_id: postId, round, approved: [] as string[], rejected: [] as string[], people: [] as { platform: string; reasons: string }[], log_thread: null, reviewed: {} as Record<string, PlatformVerdict> };
  if (!keys.length) return { ...base, next: 'done', why: 'No platform on this draft is waiting.', paused: false };

  const pause = await pauseState();
  if (pause.paused) {
    await record({ event_type: 'media_post_review_skipped', subject_id: postId, lane: 'MEDIA', actor: REVIEWER, detail: { reason: 'paused', paused_by: pause.by, pause_reason: pause.reason } });
    return { ...base, next: 'cards', paused: true, why: `Automatic posting is paused (${posts.APPROVERS[pause.by ?? ''] ?? pause.by}: ${pause.reason}). The cards go to Jason and Destiny as before.` };
  }

  const recent: Record<string, string[]> = {};
  for (const k of keys) recent[k] = await lastLive(k, [postId, ...chain.map((p) => p.post_id)]);
  const asked = await askReviewer(reviewMessage(post, keys, recent));
  const verdicts = asked.text ? parseReview(asked.text, keys) : null;
  if (!verdicts) {
    const why = asked.error ? `The second review could not run (${clip(asked.error, 300)}).` : `The second review's answer could not be read (${clip(asked.text, 200)}).`;
    const unreviewed = Object.fromEntries(keys.map((k) => [k, { pass: false, failed: [], reasons: why, fix: '' }]));
    await storeReviews(postId, unreviewed, { round, provider: asked.provider, error: why, step: 'unreviewed' });
    return { ...base, next: 'people', paused: false, reviewed: unreviewed, people: keys.map((k) => ({ platform: k, reasons: why })), why: `${why} Nothing was posted; the cards go to Jason and Destiny.` };
  }

  // The claim rules decide too: a platform the claim check marks blocked, or a target while Stage 1 has not proved
  // it, would be refused at the approval, so it fails here and is rewritten instead of waiting for a person
  // (24 Nov 2026, TEST run MTP-1795553547294-2XX3: "Grab-and-go, not a science project" on X and Instagram).
  const claimed = keys.filter((k) => ['blocked', 'target'].includes(post.platforms[k]!.claim_check_status));
  const gate = claimed.some((k) => post.platforms[k]!.claim_check_status === 'target') ? await posts.targetGate() : null;
  for (const k of claimed) {
    const d = post.platforms[k]!;
    if (d.claim_check_status === 'target' && gate?.cleared) continue;
    const lines = d.claim_findings.filter((f) => f.status === d.claim_check_status).map((f) => `"${clip(f.text, 160)}"`).join('; ') || 'a line';
    const v = verdicts[k];
    verdicts[k] = {
      pass: false,
      failed: [...new Set([...v.failed, 'stage1_from_record'])],
      reasons: `The claim check marks ${lines} as ${d.claim_check_status === 'target' ? 'a target stated as fact' : 'a blocked claim'}.${v.pass ? '' : ' ' + v.reasons}`,
      fix: `Say it as what vFarm is being built to do and how Stage 1 is testing it, not as what it does today.${v.fix ? ' ' + v.fix : ''}`,
    };
  }

  // A platform that failed this review before, or that a person rejected, goes to a person on a second fail.
  const rejectedBefore = new Set<string>();
  for (const p of chain) for (const k of keys) if (p.platforms[k]?.decision === 'rejected') rejectedBefore.add(k);
  let step = nextStep(verdicts, rejectedBefore);
  await storeReviews(postId, verdicts, { round, provider: asked.provider, error: null, step });

  const passed = keys.filter((k) => verdicts[k].pass);
  const failed = keys.filter((k) => !verdicts[k].pass);
  const approved: string[] = [];
  const refusedAtApproval: { platform: string; reasons: string }[] = [];
  let log_thread: { channel: string; ts: string } | null = null;

  // On a people step the platforms that passed wait with the rest, so the draft is decided as one.
  if (step !== 'people' && passed.length) {
    log_thread = await ensureLogThread(post, chain);
    if (!log_thread) step = 'people';
    else {
      for (const k of passed) {
        await tagStored(postId, k);
        try {
          await posts.decide(postId, { platform: k, decision: 'approve', by: REVIEWER, via: 'second_review', note: null, reviewer: true });
          approved.push(k);
        } catch (e) {
          if (!(e instanceof posts.MediaPostError)) throw e;
          refusedAtApproval.push({ platform: k, reasons: `It passed the second review but the approval refused it: ${e.message}` });
        }
      }
      if (refusedAtApproval.length) step = 'people';
    }
  }

  const rejected: string[] = [];
  if (step === 'rewrite') {
    for (const k of failed) {
      await posts.decide(postId, { platform: k, decision: 'reject', by: REVIEWER, via: 'second_review', note: note(verdicts[k]), reviewer: true });
      rejected.push(k);
    }
  }

  const people = step === 'people'
    ? [...keys.filter((k) => !approved.includes(k) && !refusedAtApproval.some((r) => r.platform === k)).map((k) => ({ platform: k, reasons: verdicts[k].pass ? 'Passed the second review; waiting with the platforms that did not.' : note(verdicts[k]) })), ...refusedAtApproval]
    : [];
  const next: ReviewOutcome['next'] = step === 'post' ? 'done' : step;
  const why =
    next === 'done' ? `All ${approved.length} platform(s) passed the second review and are posting.`
      : next === 'rewrite' ? `${rejected.join(', ')} failed the second review and go back to the Media Twin to rewrite${approved.length ? `; ${approved.join(', ')} passed and are posting` : ''}.`
        : `${people.map((p) => p.platform).join(', ')} need Jason or Destiny: ${round > 1 || rejectedBefore.size ? 'they failed the second review again' : 'the review could not settle them'}.${approved.length ? ` ${approved.join(', ')} passed and are posting.` : ''}`;
  return { ...base, next, why, paused: false, reviewed: verdicts, approved, rejected, people, log_thread };
}
