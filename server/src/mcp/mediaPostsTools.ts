/**
 * Media Twin posts over MCP (2026-11-01, Destiny). The record and its rules are ../mediaPosts.ts.
 *
 *   `read_media_posts` — read. Every Media Twin draft, newest first: the text per platform, the
 *   card and its images, the claim check, each Approve or Reject with Jason's note, the revision
 *   it replaced, and the analytics once posting is on.
 *
 * Writes come from the Media Twin's own n8n workflows over the engine routes, never from an agent.
 * `edit_media_post` — a person's exact words on a draft still waiting for its decision. Write connection, no agent's scope.
 */
import * as posts from '../mediaPosts';
import * as n8n from '../n8n';
import * as slack from '../slack';
import { auditClose, auditOpen } from './writeTools';
import type { ToolDefinition } from './tools';

const str = (args: Record<string, unknown>, key: string): string => (typeof args[key] === 'string' ? (args[key] as string).trim() : '');

export const readMediaPosts: ToolDefinition = {
  name: 'read_media_posts',
  description:
    'Read the Media Twin\'s drafts (media.post.v1), newest first: for each, the occasion and angle, the text for LinkedIn, X, Facebook and Instagram, the branded card and its image links, the claim check per platform (clean, flagged, target, blocked, with the sentence that tripped it and, on a target, which Stage 1 records are missing), Jason\'s Approve or Reject per platform with his note, the revision and the draft it replaced, the Slack card, and analytics once posting is on. Use it to see what is waiting on Jason, what he rejected and why (read the notes before rewriting a draft), and what has been approved. Each post\'s text comes back whole. Test drafts are left out unless include_test is true. Returns {schema, looked_at, summary, counts, posts, rules}: looked_at says how many drafts matched and whether all of them are in the answer, and summary gives one line per draft (status, headline, each platform live with its link or its decision) before the drafts in full. A plain read shows the NEWEST drafts only: to find a particular post, whatever its age, pass search (its words, e.g. "vertical farm twin") or post_id, or slack_ts (the ts of its Slack card or that card\'s thread). Never say a post was not done or not posted from a read that did not include it. For what went out (what was posted today, what went live on LinkedIn), pass posted_since (a date or time, e.g. today\'s date) and optionally platform: it answers one line per platform posted, with the live link and the whole text.',
  inputSchema: {
    type: 'object',
    properties: {
      post_id: { type: 'string', description: 'One draft, e.g. MTP-1793500000000-AB12.' },
      status: { type: 'string', enum: ['in_review', 'partly_decided', 'approved', 'rejected', 'superseded'] },
      include_test: { type: 'boolean' },
      limit: { type: 'number', description: 'Drafts, newest first. Default 20, at most 100.' },
      posted_since: { type: 'string', description: 'A date (YYYY-MM-DD, UTC) or time: answer only what went live since then, one line per platform with its link.' },
      platform: { type: 'string', enum: ['linkedin', 'x', 'facebook', 'instagram'], description: 'With posted_since, one platform only.' },
      search: { type: 'string', description: 'Words the draft contains (its text, headline, angle or id), e.g. "vertical farm twin". Every word must appear. Finds a draft whatever its age.' },
      slack_ts: { type: 'string', description: 'The ts of a Media Twin card in Slack, or of the thread it sits in: returns the draft that card belongs to.' },
    },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, title: 'Read the Media Twin drafts' },
  handler: async (args) =>
    str(args, 'posted_since')
      ? { ok: true, ...(await posts.posted({ since: str(args, 'posted_since'), platform: str(args, 'platform') || null, limit: typeof args.limit === 'number' ? args.limit : 50 })) }
      : {
    ok: true,
    ...(await posts.read({
      post_id: str(args, 'post_id') || null,
      status: str(args, 'status') || null,
      include_test: args.include_test === true,
      limit: Math.min(typeof args.limit === 'number' ? args.limit : 20, 100),
      search: str(args, 'search') || null,
      slack_ts: str(args, 'slack_ts') || null,
    })),
  },
};

export const editMediaPost: ToolDefinition = {
  name: 'edit_media_post',
  description:
    "Change one platform's words on a Media Twin draft directly, for a person's exact lines. HELD HERE: requester_user_id is Jason or Destiny (not_permitted); refused on any agent token; a reason is required; a platform already approved, rejected or posted cannot change (already_decided, already_posted); an X tweet over 280 characters is refused (too_long). text replaces the post, thread replaces the X thread whole. The claim rules run on the new words and the old words stay on the platform's edits. It approves nothing. The Slack card is not redrawn. dry_run checks everything and writes nothing. Audited on engine_mcp_writes.",
  inputSchema: {
    type: 'object',
    properties: {
      post_id: { type: 'string' },
      platform: { type: 'string', enum: [...posts.PLATFORMS] },
      text: { type: 'string', description: 'The whole new post text.' },
      thread: { type: 'array', items: { type: 'string' }, description: 'The whole new X thread, after the first tweet.' },
      reason: { type: 'string' },
      requester_user_id: { type: 'string' },
      dry_run: { type: 'boolean' },
    },
    required: ['post_id', 'platform', 'reason', 'requester_user_id'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false, title: 'Edit a Media Twin draft' },
  handler: async (args, deps) => {
    if (deps.agent) return { ok: false, reason: 'agent_not_permitted', message: `An agent (${deps.agent}) may not edit a Media Twin draft.` };
    const dry = args.dry_run === true;
    const requester = str(args, 'requester_user_id');
    const audit = await auditOpen({ tool: 'edit_media_post', args, access: deps.access, kind: 'media_posts', requester, dry_run: dry });
    try {
      const out = await posts.editText(str(args, 'post_id'), {
        platform: str(args, 'platform'),
        text: typeof args.text === 'string' ? args.text : null,
        thread: Array.isArray(args.thread) ? (args.thread as string[]) : null,
        by: requester,
        reason: str(args, 'reason'),
        dry_run: dry,
      });
      await auditClose(audit, { outcome: dry ? 'dry_run' : 'written', natural_id: str(args, 'post_id') });
      return { ...out, audit_id: audit };
    } catch (e) {
      if (e instanceof posts.MediaPostError) {
        await auditClose(audit, { outcome: 'refused', detail: e.reason, natural_id: str(args, 'post_id') });
        return { ok: false, reason: e.reason, message: e.message, audit_id: audit };
      }
      await auditClose(audit, { outcome: 'failed', detail: String(e), natural_id: str(args, 'post_id') });
      throw e;
    }
  },
};

export const recordMediaPostLink: ToolDefinition = {
  name: 'record_media_post_link',
  description:
    "Record the live link of a post made by hand, or replace a live link already held, on one platform of a Media Twin draft. HELD HERE: requester_user_id is Jason or Destiny (not_permitted); refused on any agent token; the platform must be approved (not_approved); a link already held is replaced only with correction_reason (already_posted), and the old one stays on the platform's posted_history. It posts nothing to any platform. One media_post_published event. dry_run checks everything and writes nothing. Audited on engine_mcp_writes.",
  inputSchema: {
    type: 'object',
    properties: {
      post_id: { type: 'string' },
      platform: { type: 'string', enum: [...posts.PLATFORMS] },
      posted_id: { type: 'string', description: "The platform's id for the post, or the link's own short code for a post made by hand." },
      posted_url: { type: 'string' },
      correction_reason: { type: 'string', description: 'Why a link already held is being replaced.' },
      requester_user_id: { type: 'string' },
      dry_run: { type: 'boolean' },
    },
    required: ['post_id', 'platform', 'posted_id', 'posted_url', 'requester_user_id'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false, title: 'Record a live post link' },
  handler: async (args, deps) => {
    if (deps.agent) return { ok: false, reason: 'agent_not_permitted', message: `An agent (${deps.agent}) may not record a live link.` };
    const dry = args.dry_run === true;
    const requester = str(args, 'requester_user_id');
    const audit = await auditOpen({ tool: 'record_media_post_link', args, access: deps.access, kind: 'media_posts', requester, dry_run: dry });
    try {
      const out = await posts.recordPosted(str(args, 'post_id'), {
        platform: str(args, 'platform'),
        posted_id: str(args, 'posted_id'),
        posted_url: str(args, 'posted_url'),
        correction_reason: args.correction_reason,
        by: requester,
        dry_run: dry,
      });
      await auditClose(audit, { outcome: dry ? 'dry_run' : 'written', natural_id: str(args, 'post_id') });
      return { ...out, audit_id: audit };
    } catch (e) {
      if (e instanceof posts.MediaPostError) {
        await auditClose(audit, { outcome: 'refused', detail: e.reason, natural_id: str(args, 'post_id') });
        return { ok: false, reason: e.reason, message: e.message, audit_id: audit };
      }
      await auditClose(audit, { outcome: 'failed', detail: String(e), natural_id: str(args, 'post_id') });
      throw e;
    }
  },
};

function gateTool(name: string, description: string, title: string, properties: Record<string, unknown>, required: string[], run: (args: Record<string, unknown>, by: string, dry: boolean) => Promise<Record<string, unknown>>, target: (args: Record<string, unknown>) => string): ToolDefinition {
  return {
    name,
    description,
    inputSchema: { type: 'object', properties: { ...properties, requester_user_id: { type: 'string' }, dry_run: { type: 'boolean' } }, required: [...required, 'requester_user_id'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false, title },
    handler: async (args, deps) => {
      if (deps.agent) return { ok: false, reason: 'agent_not_permitted', message: `An agent (${deps.agent}) may not change Jason's gate on Approve.` };
      const dry = args.dry_run === true;
      const requester = str(args, 'requester_user_id');
      const audit = await auditOpen({ tool: name, args, access: deps.access, kind: 'media_posts', requester, dry_run: dry });
      try {
        const out = await run(args, requester, dry);
        await auditClose(audit, { outcome: dry ? 'dry_run' : 'written', natural_id: target(args) });
        return { ...out, audit_id: audit };
      } catch (e) {
        if (e instanceof posts.MediaPostError) {
          await auditClose(audit, { outcome: 'refused', detail: e.reason, natural_id: target(args) });
          return { ok: false, reason: e.reason, message: e.message, audit_id: audit };
        }
        await auditClose(audit, { outcome: 'failed', detail: String(e), natural_id: target(args) });
        throw e;
      }
    },
  };
}

export const markMediaPattern = gateTool(
  'mark_media_pattern_reuse',
  "Mark a Media Twin pattern 'approved for automated reuse' (Jason's gate). pattern_ref is the Codex entry that holds the pattern (its natural id). Once marked, Approve on a draft naming that pattern posts live on the platforms automated posting reaches; everything else stays record-only. Jason or Destiny, a reason required, refused on any agent token. Never removes a mark. dry_run checks and writes nothing. Audited on engine_mcp_writes.",
  'Mark a pattern for automated reuse',
  { pattern_ref: { type: 'string' }, reason: { type: 'string' } },
  ['pattern_ref', 'reason'],
  (a, by, dry) => posts.markPattern({ pattern_ref: str(a, 'pattern_ref'), by, reason: str(a, 'reason'), dry_run: dry }),
  (a) => str(a, 'pattern_ref'),
);

export const setMediaPostPattern = gateTool(
  'set_media_post_pattern',
  "Say which pattern a Media Twin draft belongs to (pattern_ref, the Codex entry's natural id), or clear it with an empty value. Only a draft naming a marked pattern can post through Approve, and a rewrite keeps its draft's pattern. Jason or Destiny, refused on any agent token. dry_run checks and writes nothing. Audited on engine_mcp_writes.",
  'Put a draft on a pattern',
  { post_id: { type: 'string' }, pattern_ref: { type: 'string' } },
  ['post_id'],
  (a, by, dry) => posts.setPattern(str(a, 'post_id'), { pattern_ref: str(a, 'pattern_ref'), by, dry_run: dry }),
  (a) => str(a, 'post_id'),
);


/**
 * `approve_media_post` (25 Nov 2026, Destiny: approve and post from the dashboard connection, then show it on the card).
 * The same `posts.decide` the card's Approve reaches, so the claim rules run again at the click and Approve posts that
 * platform live, its link landing in the card's thread. Then the card is rewritten without its buttons and says who
 * approved it and when; a card Slack will not rewrite never undoes the approval and the answer says so.
 */
const REDRAW_PATH = process.env.MEDIA_CARD_REDRAW_PATH?.trim() || '/webhook/media-twin-card-redraw';

/**
 * Media Twin cards are posted by the Media Twin bot, and this dashboard holds no Media Twin token, so Slack refuses
 * Bays' chat.update with cant_update_message (27 Nov 2026, Q894). The card is then redrawn as the Media Twin bot by
 * n8n `Media Twin — Card Redraw Runner` (POST /webhook/media-twin-card-redraw, inbound key), through Media Twin —
 * Approval Card in update mode, the same redraw a Slack click gets. A refusal there comes back as the error.
 */
export async function redrawAsMediaTwin(postId: string, platform: string, channel: string, ts: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const key = process.env.DASHBOARD_INBOUND_KEY?.trim();
    if (!key) return { ok: false, error: 'DASHBOARD_INBOUND_KEY is not set' };
    const r = await fetch(`${n8n.n8nHost()}${REDRAW_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-dashboard-key': key },
      body: JSON.stringify({ post_id: postId, channel, cards: [{ platform, ts }] }),
      signal: AbortSignal.timeout(60_000),
    });
    const text = await r.text();
    if (!r.ok) return { ok: false, error: `redraw runner answered ${r.status}: ${text.slice(0, 200)}` };
    const body = JSON.parse(text) as Array<{ redrawn?: number }> | { redrawn?: number };
    const redrawn = Array.isArray(body) ? body[0]?.redrawn : body.redrawn;
    return redrawn === 1 ? { ok: true } : { ok: false, error: `redraw runner redrew ${String(redrawn ?? 'nothing')}: ${text.slice(0, 200)}` };
  } catch (e) {
    return { ok: false, error: `redraw runner unreachable: ${e instanceof Error ? e.message : String(e)}` };
  }
}

async function markCardApproved(channel: string | null, ts: string | null, byName: string, postId: string, platform: string): Promise<{ ok: boolean; error?: string; via?: string }> {
  if (!channel || !ts) return { ok: false, error: 'no_card' };
  const read = await slack.botCall('conversations.replies', { channel, ts, limit: 1, inclusive: true }, 'form');
  const msg = (read.ok && Array.isArray(read.messages) ? (read.messages as Array<Record<string, unknown>>)[0] : null) ?? null;
  if (!msg || String(msg.ts) !== ts) return { ok: false, error: read.ok ? 'card_not_found' : String(read.error ?? 'read_failed') };
  const at = new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  const line = `:white_check_mark: *Approved by ${byName}*, ${at}. Posting now; the live link follows in this thread.`;
  const blocks = (Array.isArray(msg.blocks) ? (msg.blocks as Array<Record<string, unknown>>) : []).filter((b) => b.type !== 'actions');
  blocks.push({ type: 'section', text: { type: 'mrkdwn', text: line } });
  const up = await slack.botCall('chat.update', { channel, ts, text: `${String(msg.text ?? '')}\n${line}`.trim(), blocks });
  if (up.ok) return { ok: true, via: 'bays' };
  if (up.error !== 'cant_update_message') return { ok: false, error: String(up.error ?? 'update_failed') };
  const redraw = await redrawAsMediaTwin(postId, platform, channel, ts);
  if (!redraw.ok) console.error(`[media-posts] card for ${postId} ${platform} not redrawn: ${redraw.error}`);
  return redraw.ok ? { ok: true, via: 'media_twin' } : { ok: false, error: `cant_update_message, then ${redraw.error}` };
}

export const approveMediaPost: ToolDefinition = {
  name: 'approve_media_post',
  description:
    "Approve one or more platforms of a Media Twin draft, the same Approve the Slack card gives: the claim rules run again on the stored text, and an approved platform posts live (its link goes in that card's thread). Then each card is rewritten without its buttons, saying who approved it and when. HELD HERE: requester_user_id is Jason or Destiny (not_permitted); refused on any agent token; a blocked or uncleared target claim is refused. dry_run checks the draft and changes nothing. Audited on engine_mcp_writes.",
  inputSchema: {
    type: 'object',
    properties: {
      post_id: { type: 'string' },
      platforms: { type: 'array', items: { type: 'string', enum: [...posts.PLATFORMS] }, description: 'The platforms to approve.' },
      requester_user_id: { type: 'string' },
      dry_run: { type: 'boolean' },
    },
    required: ['post_id', 'platforms', 'requester_user_id'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true, title: 'Approve and post a Media Twin draft' },
  handler: async (args, deps) => {
    if (deps.agent) return { ok: false, reason: 'agent_not_permitted', message: `An agent (${deps.agent}) may not approve a Media Twin draft.` };
    const dry = args.dry_run === true;
    const requester = str(args, 'requester_user_id');
    const postId = str(args, 'post_id');
    const list = Array.isArray(args.platforms) ? [...new Set((args.platforms as unknown[]).map(String))] : [];
    if (!list.length) return { ok: false, reason: 'bad_value', message: 'Name at least one platform.' };
    if (!posts.APPROVERS[requester]) return { ok: false, reason: 'not_permitted', message: 'Only Jason or Destiny approve a Media Twin post.' };
    const audit = await auditOpen({ tool: 'approve_media_post', args, access: deps.access, kind: 'media_posts', requester, dry_run: dry });
    if (dry) {
      const read = await posts.read({ post_id: postId, status: null, include_test: true, limit: 1, search: null, slack_ts: null });
      const post = (read.posts as Array<{ platforms: Record<string, { decision: string; claim_check_status: string }> }>)[0];
      await auditClose(audit, { outcome: 'dry_run', natural_id: postId });
      if (!post) return { ok: false, reason: 'not_found', message: `No Media Twin post ${postId}.`, audit_id: audit };
      return { ok: true, dry_run: true, would_approve: list.map((p) => ({ platform: p, decision_now: post.platforms[p]?.decision ?? 'missing', claim_check: post.platforms[p]?.claim_check_status ?? null })), audit_id: audit };
    }
    const results: Array<Record<string, unknown>> = [];
    for (const platform of list) {
      try {
        const out = await posts.decide(postId, { platform, decision: 'approve', by: requester, via: 'mcp:approve_media_post' });
        const p = out.post.platforms[platform as posts.Platform];
        const card = await markCardApproved(out.post.slack_channel, p?.slack_ts ?? null, posts.APPROVERS[requester], postId, platform);
        results.push({ platform, approved: true, auto_post: out.auto_post, card_updated: card.ok, ...(card.ok ? { card_redrawn_by: card.via } : { card_error: card.error }) });
      } catch (e) {
        if (e instanceof posts.MediaPostError) results.push({ platform, approved: false, reason: e.reason, message: e.message });
        else results.push({ platform, approved: false, reason: 'failed', message: String(e) });
      }
    }
    const ok = results.every((r) => r.approved === true);
    await auditClose(audit, { outcome: ok ? 'written' : results.some((r) => r.approved) ? 'partial' : 'refused', natural_id: postId, detail: JSON.stringify(results).slice(0, 2000) });
    return { ok, results, note: 'Approve posts in the background; each live link lands in its card\'s thread. Read the draft with read_media_posts to see posted_url.', audit_id: audit };
  },
};

export const MEDIA_POSTS_READ_TOOLS: ToolDefinition[] = [readMediaPosts];
export const MEDIA_POSTS_WRITE_TOOLS: ToolDefinition[] = [editMediaPost, approveMediaPost, recordMediaPostLink, markMediaPattern, setMediaPostPattern];
