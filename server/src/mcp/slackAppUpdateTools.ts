/**
 * `update_slack_app` (15 Nov 2026, Destiny): change the setup of one of BHA's own Slack apps (commands, display,
 * home tab, agent mode, scopes, events, request URLs) through ../slackAppUpdate.ts. Write connection only, in no
 * agent's scope, refused on any agent token, Destiny or Jason. Without confirm it changes nothing and answers the
 * change set with Slack's own validation; with confirm "UPDATE <app_id>" it writes, then reads the manifest back.
 * Audited on engine_mcp_writes (kind slack_apps), before and after.
 */
import * as upd from '../slackAppUpdate';
import { auditClose, auditOpen } from './writeTools';
import type { ToolDefinition } from './tools';

const ALLOWED = new Set(['U0AEW3TBYH1', 'U0A9V97949F']);

export const updateSlackApp: ToolDefinition = {
  name: 'update_slack_app',
  description:
    'Change the setup of one of BHA\'s own Slack apps (one Destiny collaborates on), read live from Slack, never from a stored copy. changes: remove_commands (slash commands to take off), display {name, description, long_description, background_color}, bot_display_name, home_tab, messages_tab, assistant ({description, suggested_prompts} turns on Slack\'s agent mode; false turns it off), bot_scopes_add / bot_scopes_remove, bot_events_add / bot_events_remove, event_url, interactivity_url, redirect_urls_add / redirect_urls_remove (the https addresses Sign in with Slack may return a person to). Slack validates the result first. Without confirm nothing is written and the answer is the change set. With confirm exactly "UPDATE <app_id>" it is written and read back; read_back says whether Slack holds every change. A scope change needs the app reinstalled by a person (reinstall_needed). It cannot set the app\'s picture: Slack has no API for that. Destiny (U0AEW3TBYH1) or Jason (U0A9V97949F) only, never an agent. reason: why, 3 to 1,000 characters. Audited on engine_mcp_writes.',
  inputSchema: {
    type: 'object',
    properties: {
      app_id: { type: 'string', description: 'The Slack app id, A…' },
      changes: { type: 'object', description: 'The changes, by the keys listed above.' },
      requester_user_id: { type: 'string', description: 'Destiny or Jason.' },
      reason: { type: 'string', description: 'Why, 3 to 1,000 characters.' },
      confirm: { type: 'string', description: 'Exactly "UPDATE <app_id>" to write. Omit for a preview.' },
    },
    required: ['app_id', 'changes', 'requester_user_id', 'reason'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true, title: 'Change a Slack app\'s setup' },
  handler: async (args, deps) => {
    const appId = typeof args.app_id === 'string' ? args.app_id.trim() : '';
    const requester = typeof args.requester_user_id === 'string' ? args.requester_user_id.trim() : '';
    const reason = typeof args.reason === 'string' ? args.reason.trim() : '';
    const confirm = typeof args.confirm === 'string' ? args.confirm.trim() : '';
    const changes = (args.changes && typeof args.changes === 'object' ? args.changes : {}) as upd.Changes;
    const apply = confirm.length > 0;
    const audit = await auditOpen({ tool: 'update_slack_app', args, access: deps.access, kind: 'slack_apps', requester: requester || null, dry_run: !apply });
    const refuse = async (r: string, message: string) => {
      await auditClose(audit, { outcome: 'refused', detail: message, natural_id: appId || null, guard_result: { reason: r } });
      return { ok: false, applied: false, reason: r, message, audit_id: audit };
    };
    if (deps.agent) return refuse('agent_not_permitted', `An agent (${deps.agent}) may not change a Slack app: Destiny or Jason does, through the connector.`);
    if (!ALLOWED.has(requester)) return refuse('not_permitted', 'Only Destiny (U0AEW3TBYH1) or Jason (U0A9V97949F) can change a Slack app.');
    if (reason.length < 3 || reason.length > 1000) return refuse('reason_required', 'A reason of 3 to 1,000 characters is required.');
    if (apply && confirm !== `UPDATE ${appId}`) return refuse('confirm_mismatch', `confirm must be exactly "UPDATE ${appId}".`);

    const r = await upd.update(appId, changes, { apply });
    if (!r.ok) {
      await auditClose(audit, { outcome: 'refused', detail: r.message, natural_id: appId, guard_result: { reason: r.reason, problems: r.problems ?? [] }, after: r.changes ?? null });
      return { ...r, applied: false, audit_id: audit };
    }
    const before = Object.fromEntries(r.changes.map((c) => [c.field, c.before]));
    const after = Object.fromEntries(r.changes.map((c) => [c.field, c.after]));
    await auditClose(audit, {
      outcome: r.applied ? (r.read_back === 'matches' ? 'applied' : 'applied_differs') : 'dry_run',
      detail: `${r.changes.length} change(s): ${r.changes.map((c) => c.field).join(', ')}${r.applied ? `; read back ${r.read_back}` : '; validated by Slack, not written'}${r.reinstall_needed ? '; reinstall needed' : ''}`,
      natural_id: appId,
      before,
      after,
    });
    return {
      ...r,
      ...(r.applied ? {} : { confirm_with: `UPDATE ${appId}`, note: 'Validated by Slack. Nothing was written: call again with confirm to apply.' }),
      ...(r.reinstall_needed ? { reinstall: 'Scopes changed: Slack needs the app reinstalled by a person before the new scopes take effect (api.slack.com/apps, Install App).' } : {}),
      audit_id: audit,
    };
  },
};

export const SLACK_APP_UPDATE_WRITE_TOOLS: ToolDefinition[] = [updateSlackApp];
