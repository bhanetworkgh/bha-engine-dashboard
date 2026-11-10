/**
 * delete_slack_messages (10 Nov 2026, Destiny). Takes down the engine's own Slack posts: test cards, notices and
 * confirmations left in real channels (slackDelete.ts). A person's tool: write connection only, in no agent's scope,
 * refused on any agent token, Destiny or Jason. Without `confirm` it is a preview; with `confirm: "DELETE <n>"`, n the
 * number the preview found, it deletes. Every post's text is kept on the audit line (kind slack) before it goes.
 */
import * as del from '../slackDelete';
import * as engineEvents from '../engineEvents';
import { ADMIN_IDS } from '../writeGuards';
import { currentAgent } from './caller';
import { auditClose, auditOpen } from './writeTools';
import type { ToolDefinition } from './tools';

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

export const deleteSlackMessagesTool: ToolDefinition = {
  name: 'delete_slack_messages',
  description:
    'Delete the engine\'s own Slack messages: test cards, parked-log notices, test confirmations and the like. Only posts by an engine bot (Bays, North Star, Research Twin) can go, each deleted as the bot that posted it; a person\'s message is never touched. Name them by messages (permalinks, or {channel, ts}) or by a search: channel, contains (3 or more characters the post must include, matched case-blind over its text and blocks, thread replies included) and since_hours (24 by default, 168 at most). with_replies also takes the engine bots\' replies under each post. Without confirm it is a preview: what would go, with each post\'s text, and confirm_with. With confirm exactly "DELETE <n>", n the number found, it deletes; 50 at most a call. Each post\'s full text is kept on the audit line first. requester_user_id: Destiny or Jason.',
  inputSchema: {
    type: 'object',
    properties: {
      messages: { type: 'array', items: {}, description: 'Slack message links, or {channel, ts} (add thread_ts for a reply).' },
      channel: { type: 'string', description: 'For a search: the channel id.' },
      contains: { type: 'string', description: 'For a search: words the post must include, 3 characters at least.' },
      since_hours: { type: 'number', description: 'For a search: how far back. 24 by default, 168 at most.' },
      with_replies: { type: 'boolean', description: 'Also delete the engine bots\' replies in each found post\'s thread.' },
      confirm: { type: 'string', description: '"DELETE <n>", n the number the preview found. Leave out for a preview.' },
      reason: { type: 'string', description: 'Why, for the audit line.' },
      requester_user_id: { type: 'string', description: 'Destiny or Jason.' },
    },
    required: ['requester_user_id'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true, title: 'Delete the engine\'s own Slack messages' },
  handler: async (args, deps) => {
    const requester = str(args.requester_user_id) || null;
    const confirm = str(args.confirm);
    const preview = !confirm;
    const audit = await auditOpen({ tool: 'delete_slack_messages', args, access: deps.access, kind: 'slack', requester, dry_run: preview });
    const refuse = async (why: string, message: string) => {
      await auditClose(audit, { outcome: 'refused', detail: `${why}: ${message}`, guard_result: { reason: why } });
      return { ok: false, reason: why, message: `${message} Nothing was deleted.`, audit_id: audit };
    };
    if (currentAgent()) return refuse('agent_token', 'This is a person\'s tool and is refused on an agent token.');
    if (!requester || !ADMIN_IDS.includes(requester)) return refuse('not_permitted', 'Only Destiny or Jason can delete Slack messages.');
    const messages = Array.isArray(args.messages) ? args.messages : [];
    if (!messages.length && !str(args.channel)) return refuse('nothing_named', 'Name the posts: messages (links), or a search with channel and contains.');
    if (messages.length > del.MAX_DELETE) return refuse('too_many', `At most ${del.MAX_DELETE} messages a call.`);
    try {
      const f = await del.find({ messages, channel: str(args.channel), contains: str(args.contains), since_hours: Number(args.since_hours) || undefined, with_replies: args.with_replies === true });
      const n = f.found.length;
      const listed = f.found.map(({ text, ...rest }) => ({ ...rest, text: text.slice(0, 300) }));
      if (preview) {
        await auditClose(audit, { outcome: 'dry_run', detail: `${n} found, ${f.skipped.length} skipped`, after: { found: listed, skipped: f.skipped } });
        return {
          ok: true,
          preview: true,
          found_count: n,
          found: listed,
          skipped: f.skipped,
          confirm_with: n ? `DELETE ${n}` : null,
          message: n ? `Nothing was deleted. Call again with confirm "DELETE ${n}" to delete these ${n}.` : 'Nothing to delete.',
          audit_id: audit,
        };
      }
      if (n === 0) return refuse('nothing_found', 'No engine post matches.');
      if (n > del.MAX_DELETE) return refuse('too_many', `${n} posts match; at most ${del.MAX_DELETE} a call. Narrow the search.`);
      if (confirm !== `DELETE ${n}`) return refuse('confirm_mismatch', `confirm must be exactly "DELETE ${n}": ${n} posts match now. Preview again if that is not what you expected.`);
      const r = await del.remove(f.found);
      const out = { ok: r.failed.length === 0, deleted_count: r.deleted.length, deleted: r.deleted.map((x) => ({ link: x.link, posted_by: x.posted_by })), failed: r.failed.map((x) => ({ link: x.link, error: x.error })), skipped: f.skipped, raise: r.failed.length > 0 };
      // The audit line keeps every post whole: once Slack lets go this is the only place it can be read.
      await auditClose(audit, { outcome: r.failed.length ? 'failed' : 'applied', detail: `deleted ${r.deleted.length} of ${n}${str(args.reason) ? `: ${str(args.reason)}` : ''}`, before: f.found, after: out });
      await engineEvents
        .record({ event_type: 'slack_messages_deleted', subject_id: `audit:${audit}`, actor: requester, detail: { deleted: r.deleted.length, failed: r.failed.length, reason: str(args.reason) || null, links: r.deleted.map((x) => x.link).slice(0, 50) } })
        .catch((e) => console.error(`[slack-delete] event not recorded: ${e instanceof Error ? e.message : String(e)}`));
      return { ...out, audit_id: audit };
    } catch (e) {
      const reason = e instanceof del.DeleteError ? e.reason : 'failed';
      const message = e instanceof Error ? e.message : String(e);
      await auditClose(audit, { outcome: e instanceof del.DeleteError ? 'refused' : 'failed', detail: `${reason}: ${message}`, guard_result: { reason } });
      return { ok: false, reason, message, raise: !(e instanceof del.DeleteError), audit_id: audit };
    }
  },
};

export const SLACK_DELETE_WRITE_TOOLS: ToolDefinition[] = [deleteSlackMessagesTool];
