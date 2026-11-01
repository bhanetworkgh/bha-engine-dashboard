/**
 * Media Twin posts over MCP (2026-11-01, Destiny). The record and its rules are ../mediaPosts.ts.
 *
 *   `read_media_posts` — read. Every Media Twin draft, newest first: the text per platform, the
 *   card and its images, the claim check, each Approve or Reject with Jason's note, the revision
 *   it replaced, and the analytics once posting is on.
 *
 * Writes come from the Media Twin's own n8n workflows over the engine routes, never from an agent.
 */
import * as posts from '../mediaPosts';
import type { ToolDefinition } from './tools';

const str = (args: Record<string, unknown>, key: string): string => (typeof args[key] === 'string' ? (args[key] as string).trim() : '');

export const readMediaPosts: ToolDefinition = {
  name: 'read_media_posts',
  description:
    'Read the Media Twin\'s drafts (media.post.v1), newest first: for each, the occasion and angle, the text for LinkedIn, X, Facebook and Instagram, the branded card and its image links, the claim check per platform (clean, flagged, blocked, with the sentence that tripped it), Jason\'s Approve or Reject per platform with his note, the revision and the draft it replaced, the Slack card, and analytics once posting is on. Use it to see what is waiting on Jason, what he rejected and why (read the notes before rewriting a draft), and what has been approved. Test drafts are left out unless include_test is true. Returns {schema, counts, posts, rules}.',
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

export const MEDIA_POSTS_READ_TOOLS: ToolDefinition[] = [readMediaPosts];
