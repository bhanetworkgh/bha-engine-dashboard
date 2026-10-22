/**
 * The Media Twin post log over MCP (2026-10-22, Destiny — H58Q, Jason's SOURCE_TO_TARGET_LOG).
 * The rules and the store are ../mediaPostLog.ts; these tools only carry a call to it.
 *
 *   `read_media_post_log`   — read. Every post row, newest first, with counts and the rules.
 *   `write_media_post_log`  — log a post or update one. Refused, with nothing written, when a rule says no.
 *
 * Every write call is on engine_mcp_writes, kind media_post_log, refused ones included.
 */
import * as log from '../mediaPostLog';
import { auditClose, auditOpen } from './writeTools';
import type { ToolDefinition } from './tools';

const str = (args: Record<string, unknown>, key: string): string => (typeof args[key] === 'string' ? (args[key] as string).trim() : '');
const bare = (v: string) => v.replace(/^<@?([A-Z0-9]+)(\|[^>]*)?>$/, '$1');

export const readMediaPostLog: ToolDefinition = {
  name: 'read_media_post_log',
  description:
    'Read the Media Twin post log (media.post_log.v1, Jason\'s SOURCE_TO_TARGET_LOG): one row per post of one vFarm picture to one place, newest first, with the source it came from, the picture (asset_id, asset_version, the Drive file in the "Approved vFarm renders" folder), the platform, classification and claim_state, Jason\'s approval, the tracked /vfarm link, the publish result, the live post\'s link or id, and the read-back. Use it to answer "which picture went where", "was it approved", "what is waiting on Jason". Test rows are left out unless include_test is true, and are labelled. Returns {schema, approved_renders_folder, counts, rows, rules}.',
  inputSchema: {
    type: 'object',
    properties: {
      log_id: { type: 'string', description: 'One row, e.g. MPL-1792600000000-AB12.' },
      asset_id: { type: 'string', description: 'Only this picture, e.g. H58Q-A.' },
      platform: { type: 'string', enum: [...log.PLATFORMS] },
      include_test: { type: 'boolean', description: 'Include rows marked as tests. Default false.' },
      limit: { type: 'number', description: 'Rows, newest first. Default 100, at most 500.' },
    },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, title: 'Read the Media Twin post log' },
  handler: async (args) => ({
    ok: true,
    ...(await log.read({
      log_id: str(args, 'log_id') || null,
      asset_id: str(args, 'asset_id') || null,
      platform: str(args, 'platform') || null,
      include_test: args.include_test === true,
      limit: typeof args.limit === 'number' ? args.limit : undefined,
    })),
  }),
};

export const writeMediaPostLog: ToolDefinition = {
  name: 'write_media_post_log',
  description:
    `Log ONE post of a vFarm picture, or update one (media.post_log.v1). Leave log_id out to log a new row; send it to update (only the fields you send change). fields: ${log.FIELDS.join(', ')}. asset_id, asset_version, source_id and platform are fixed once logged: a different picture, source or platform is a new row. THESE RULES ARE JASON'S AND ARE HELD HERE ON EVERY PATH: classification stays CONCEPTUAL and verified_current_p1_0 false (verified_current_blocked); automation_enabled is always false (automation_off); APPROVE_FOR_EA_PUBLICATION is Jason's (${log.JASON}) only (approval_is_jasons); queued or published needs that approval, asset_file_id of a file in the "Approved vFarm renders" Drive folder (asset_not_in_folder; drive_unchecked when Drive cannot say), and for a social platform a bhanetwork.org/vfarm link with utm_source = the platform, utm_medium=social and a utm_campaign (utm_required, utm_wrong); published needs the live post's own target_url or target_id (target_required); a published row never goes back (already_published). Every id comes from a person or a platform: never make one up. A refusal writes nothing: report its message as it is. dry_run checks everything (Drive included) and writes nothing. test: true on create marks a test row, labelled everywhere and left out of the counts. Each write is one media_post_logged or media_post_updated event. Returns {ok, written, created, row, event_id, message}. Audited on engine_mcp_writes.`,
  inputSchema: {
    type: 'object',
    properties: {
      log_id: { type: 'string', description: 'The row to update. Leave out to log a new one.' },
      fields: { type: 'object', description: `The post's fields by these names: ${log.FIELDS.join(', ')}.` },
      requester_user_id: { type: 'string', description: 'Slack id of the person logging this. Required.' },
      test: { type: 'boolean', description: 'On create only: true marks a TEST row. Never on a real post.' },
      dry_run: { type: 'boolean', description: 'Check everything and write nothing.' },
    },
    required: ['fields', 'requester_user_id'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true, title: 'Log or update a Media Twin post' },
  handler: async (args, deps) => {
    const requester = bare(str(args, 'requester_user_id')) || null;
    const dry = args.dry_run === true;
    const audit = await auditOpen({ tool: 'write_media_post_log', args, access: deps.access, kind: 'media_post_log', requester, dry_run: dry });
    try {
      const r = await log.write({
        log_id: str(args, 'log_id') || null,
        fields: (args.fields ?? {}) as Record<string, unknown>,
        by: requester ?? '',
        via: `mcp${deps.agent ? `:${deps.agent}` : ''}`,
        test: args.test === true,
        dry_run: dry,
        inApprovedFolder: log.inApprovedFolder,
      });
      await auditClose(audit, {
        outcome: dry ? 'dry_run' : !r.written ? 'unchanged' : r.created ? 'inserted' : 'updated',
        detail: r.message,
        natural_id: dry && r.created ? null : r.row.log_id,
        after: r.row,
      });
      return { ...r, audit_id: audit };
    } catch (e) {
      if (e instanceof log.MediaPostLogError) {
        await auditClose(audit, { outcome: 'refused', detail: `${e.reason}: ${e.message}`, natural_id: str(args, 'log_id') || null, guard_result: { reason: e.reason, ...e.extra } });
        return { ok: false, written: false, reason: e.reason, message: `${e.message} Nothing was written.`, ...e.extra, audit_id: audit };
      }
      const message = e instanceof Error ? e.message : String(e);
      await auditClose(audit, { outcome: 'failed', detail: message });
      return { ok: false, written: false, reason: 'error', message: `${message} Nothing was written.`, raise: true, audit_id: audit };
    }
  },
};

export const MEDIA_POST_LOG_READ_TOOLS: ToolDefinition[] = [readMediaPostLog];
export const MEDIA_POST_LOG_WRITE_TOOLS: ToolDefinition[] = [writeMediaPostLog];
