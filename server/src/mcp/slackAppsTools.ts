/**
 * `read_slack_apps` (13 Nov 2026, Destiny): every Slack app on the workspace, its slash commands, its bot and what it
 * listens on, from ../slackApps.ts. Read only, both connections, in no agent's scope. `refresh: true` reads Slack
 * again first (at most once a minute); it never changes an app.
 */
import * as apps from '../slackApps';
import * as mirror from '../mirror';
import type { ToolDefinition } from './tools';

export const readSlackApps: ToolDefinition = {
  name: 'read_slack_apps',
  description: `Every Slack app on BHA's workspace, read from Slack: its name, its bot user, which engine bot it is (Bays, North Star, Research Twin) where it is one, its slash commands with where each is answered (a request URL, socket mode, or nothing), the events and interactivity URLs it listens on, and its scopes. Use it to answer "which app owns /x", "what commands do we have" or "what does this app do". shared_commands lists a command two installed apps both claim. An app whose manifest Slack would not export is still listed, with Slack's reason in read_error (only apps Destiny collaborates on can be read). Filters: app (name or app id, words), command (e.g. "/sample-command"). refresh: true reads Slack again before answering (at most once a minute) and reads any app_ids named, for an app with no bot user. Read only: it never creates, changes or removes an app or a command.`,
  inputSchema: {
    type: 'object',
    properties: {
      app: { type: 'string', description: 'Name words or an app id (A…).' },
      command: { type: 'string', description: 'A slash command, with or without the slash.' },
      refresh: { type: 'boolean', description: 'Read Slack again first.' },
      app_ids: { type: 'array', items: { type: 'string' }, description: 'With refresh: app ids Slack does not list (no bot user).' },
      include_manifest_scopes: { type: 'boolean', description: 'Keep scopes and bot events on each app (left off by default to keep the answer short).' },
    },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true, title: 'Read the Slack apps and their commands' },
  handler: async (args, deps) => {
    const t0 = Date.now();
    const a = (args ?? {}) as { app?: string; command?: string; refresh?: boolean; app_ids?: string[]; include_manifest_scopes?: boolean };
    const result = a.refresh ? await apps.read({ extra: a.app_ids ?? [], by: 'mcp' }) : null;
    const s = await apps.show();
    const term = a.app?.trim().toLowerCase() ?? '';
    const cmd = a.command?.trim().toLowerCase().replace(/^\/?/, '/') ?? '';
    let rows = s.apps;
    if (term) rows = rows.filter((r) => r.app_id.toLowerCase() === term || (r.name ?? '').toLowerCase().includes(term));
    if (cmd) rows = rows.filter((r) => (r.commands ?? []).some((c) => c.command.toLowerCase() === cmd));
    const shaped = rows.map((r) => {
      const { bot_scopes, user_scopes, bot_events, ...rest } = r;
      return a.include_manifest_scopes ? r : { ...rest, scope_count: bot_scopes.length + user_scopes.length, bot_event_count: bot_events.length };
    });
    await mirror.logWrite({ endpoint: 'mcp:read_slack_apps', kind: 'slack_apps', method: 'MCP', key_label: deps.access === 'write' ? 'MCP_WRITE_TOKEN' : 'MCP_SECRET', outcome: 'read', detail: `${shaped.length} app(s)${result ? `; refresh ${result.ok ? 'ok' : result.reason}` : ''}`, ms: Date.now() - t0 });
    return {
      ...(result ? { refresh: result } : {}),
      last_read: s.last_read,
      token: s.token,
      apps: shaped,
      shared_commands: s.shared_commands,
      ...(cmd && !shaped.length ? { found: `No app held here declares ${cmd}.${s.apps.some((r) => !r.readable) ? ` ${s.apps.filter((r) => !r.readable).length} app(s) could not be read, so it may be one of them.` : ''}` } : {}),
      page_url: `${process.env.PUBLIC_DASHBOARD_URL?.trim() || 'https://dashboard.bhanetwork.org'}/registry?tab=slack-apps`,
      note: s.note,
    };
  },
};

export const SLACK_APPS_READ_TOOLS: ToolDefinition[] = [readSlackApps];
