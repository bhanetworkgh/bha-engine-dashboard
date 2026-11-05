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
import { auditClose, auditOpen } from './writeTools';
import type { ToolDefinition } from './tools';

const str = (args: Record<string, unknown>, key: string): string => (typeof args[key] === 'string' ? (args[key] as string).trim() : '');

export const readMediaPosts: ToolDefinition = {
  name: 'read_media_posts',
  description:
    'Read the Media Twin\'s drafts (media.post.v1), newest first: for each, the occasion and angle, the text for LinkedIn, X, Facebook and Instagram, the branded card and its image links, the claim check per platform (clean, flagged, target, blocked, with the sentence that tripped it and, on a target, which Stage 1 records are missing), Jason\'s Approve or Reject per platform with his note, the revision and the draft it replaced, the Slack card, and analytics once posting is on. Use it to see what is waiting on Jason, what he rejected and why (read the notes before rewriting a draft), and what has been approved. Each post\'s text comes back whole. Test drafts are left out unless include_test is true. Returns {schema, counts, posts, rules}.',
  inputSchema: {
    type: 'object',
    properties: {
      post_id: { type: 'string', description: 'One draft, e.g. MTP-1793500000000-AB12.' },
      status: { type: 'string', enum: ['in_review', 'partly_decided', 'approved', 'rejected', 'superseded'] },
      include_test: { type: 'boolean' },
      limit: { type: 'number', description: 'Drafts, newest first. Default 20, at most 100.' },
    },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, title: 'Read the Media Twin drafts' },
  handler: async (args) => ({
    ok: true,
    ...(await posts.read({
      post_id: str(args, 'post_id') || null,
      status: str(args, 'status') || null,
      include_test: args.include_test === true,
      limit: Math.min(typeof args.limit === 'number' ? args.limit : 20, 100),
    })),
  }),
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

export const MEDIA_POSTS_READ_TOOLS: ToolDefinition[] = [readMediaPosts];
export const MEDIA_POSTS_WRITE_TOOLS: ToolDefinition[] = [editMediaPost];
