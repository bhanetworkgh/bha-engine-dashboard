/**
 * Change the setup of one of BHA's own Slack apps from here (15 Nov 2026, Destiny: the Genie rebuild needs its
 * slash commands removed and, next, its description, home tab, scopes and agent mode set, and none of that should
 * need a person clicking in Slack's settings).
 *
 * One function, `update`, behind the tool `update_slack_app`. It never writes a manifest it was handed: it reads the
 * app's live manifest with `apps.manifest.export`, applies only the listed kinds of change (`applyChanges`, pure),
 * has Slack check the result with `apps.manifest.validate`, and only then, with confirm, writes it with
 * `apps.manifest.update`. The manifest is read back afterwards and every change compared, so "applied" means Slack
 * holds it. The configuration token is the one slackApps.ts already rotates; it is never returned.
 *
 * What it cannot do: a picture (Slack has no API for an app's icon) and installing the app again after a scope
 * change (Slack needs a person to approve it). The answer says when a reinstall is needed.
 */
import * as apps from './slackApps';

export type Changes = {
  remove_commands?: string[];
  display?: { name?: string; description?: string; long_description?: string; background_color?: string };
  bot_display_name?: string;
  home_tab?: boolean;
  messages_tab?: boolean;
  assistant?: false | { description: string; suggested_prompts?: Array<{ title: string; message: string }> };
  bot_scopes_add?: string[];
  bot_scopes_remove?: string[];
  bot_events_add?: string[];
  bot_events_remove?: string[];
  event_url?: string;
  interactivity_url?: string;
};

export type Change = { field: string; before: unknown; after: unknown };

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const uniq = (a: string[]) => [...new Set(a)];
const slashName = (c: string) => '/' + c.trim().replace(/^\/+/, '').toLowerCase();

/** Apply the changes to a copy of the manifest. Pure. Returns the new manifest, what changed, and what was refused. */
export function applyChanges(manifest: Record<string, any>, c: Changes): { manifest: Record<string, any>; changes: Change[]; problems: string[] } {
  const m = clone(manifest);
  const changes: Change[] = [];
  const problems: string[] = [];
  const set = (field: string, before: unknown, after: unknown) => {
    if (JSON.stringify(before) !== JSON.stringify(after)) changes.push({ field, before, after });
  };
  m.features ??= {};
  m.settings ??= {};
  m.display_information ??= {};

  if (c.remove_commands?.length) {
    const want = new Set(c.remove_commands.map(slashName));
    const held: Array<Record<string, unknown>> = Array.isArray(m.features.slash_commands) ? m.features.slash_commands : [];
    for (const name of want) if (!held.some((x) => slashName(String(x.command ?? '')) === name)) problems.push(`${name} is not a command of this app`);
    const kept = held.filter((x) => !want.has(slashName(String(x.command ?? ''))));
    set('features.slash_commands', held.map((x) => x.command), kept.map((x) => x.command));
    if (kept.length) m.features.slash_commands = kept;
    else delete m.features.slash_commands;
  }

  if (c.display) {
    const d = c.display;
    if (d.name !== undefined && (d.name.trim().length < 1 || d.name.length > 35)) problems.push('display.name must be 1 to 35 characters');
    if (d.description !== undefined && d.description.length > 140) problems.push('display.description must be at most 140 characters');
    if (d.long_description !== undefined && (d.long_description.length < 175 || d.long_description.length > 4000)) problems.push('display.long_description must be 175 to 4,000 characters (Slack\'s limit)');
    if (d.background_color !== undefined && !/^#[0-9a-fA-F]{6}$/.test(d.background_color)) problems.push('display.background_color must be a hex colour like #1D2E1C');
    for (const k of ['name', 'description', 'long_description', 'background_color'] as const) {
      if (d[k] === undefined) continue;
      set(`display_information.${k}`, m.display_information[k] ?? null, d[k]);
      m.display_information[k] = d[k];
    }
  }

  if (c.bot_display_name !== undefined) {
    m.features.bot_user ??= {};
    set('features.bot_user.display_name', m.features.bot_user.display_name ?? null, c.bot_display_name);
    m.features.bot_user.display_name = c.bot_display_name;
  }

  if (c.home_tab !== undefined || c.messages_tab !== undefined) {
    m.features.app_home ??= {};
    if (c.home_tab !== undefined) {
      set('features.app_home.home_tab_enabled', m.features.app_home.home_tab_enabled ?? null, c.home_tab);
      m.features.app_home.home_tab_enabled = c.home_tab;
    }
    if (c.messages_tab !== undefined) {
      set('features.app_home.messages_tab_enabled', m.features.app_home.messages_tab_enabled ?? null, c.messages_tab);
      m.features.app_home.messages_tab_enabled = c.messages_tab;
    }
  }

  if (c.assistant !== undefined) {
    const before = m.features.assistant_view ?? null;
    if (c.assistant === false) {
      delete m.features.assistant_view;
      set('features.assistant_view', before, null);
    } else {
      if (!c.assistant.description?.trim()) problems.push('assistant.description is required');
      const prompts = c.assistant.suggested_prompts ?? [];
      if (prompts.length > 4) problems.push('assistant.suggested_prompts holds at most 4');
      const view: Record<string, unknown> = { assistant_description: c.assistant.description };
      if (prompts.length) view.suggested_prompts = prompts;
      m.features.assistant_view = view;
      set('features.assistant_view', before, view);
    }
  }

  if (c.bot_scopes_add?.length || c.bot_scopes_remove?.length) {
    m.oauth_config ??= {};
    m.oauth_config.scopes ??= {};
    const before: string[] = Array.isArray(m.oauth_config.scopes.bot) ? m.oauth_config.scopes.bot.map(String) : [];
    const rm = new Set(c.bot_scopes_remove ?? []);
    const after = uniq([...before.filter((s) => !rm.has(s)), ...(c.bot_scopes_add ?? [])]);
    set('oauth_config.scopes.bot', before, after);
    m.oauth_config.scopes.bot = after;
  }

  if (c.bot_events_add?.length || c.bot_events_remove?.length) {
    m.settings.event_subscriptions ??= {};
    const before: string[] = Array.isArray(m.settings.event_subscriptions.bot_events) ? m.settings.event_subscriptions.bot_events.map(String) : [];
    const rm = new Set(c.bot_events_remove ?? []);
    const after = uniq([...before.filter((s) => !rm.has(s)), ...(c.bot_events_add ?? [])]);
    set('settings.event_subscriptions.bot_events', before, after);
    m.settings.event_subscriptions.bot_events = after;
  }

  for (const [key, path] of [['event_url', 'event_subscriptions'], ['interactivity_url', 'interactivity']] as const) {
    const v = c[key];
    if (v === undefined) continue;
    if (!/^https:\/\/[^\s]+$/.test(v)) {
      problems.push(`${key} must be an https URL`);
      continue;
    }
    m.settings[path] ??= {};
    set(`settings.${path}.request_url`, m.settings[path].request_url ?? null, v);
    m.settings[path].request_url = v;
    if (path === 'interactivity') m.settings.interactivity.is_enabled = true;
  }

  return { manifest: m, changes, problems };
}

export type UpdateResult =
  | { ok: true; applied: boolean; app_id: string; changes: Change[]; permissions_updated: boolean; reinstall_needed: boolean; read_back: 'matches' | 'differs'; differs?: string[] }
  | { ok: false; reason: string; message: string; app_id: string; changes?: Change[]; problems?: string[] };

async function exportManifest(appId: string, token: string): Promise<{ ok: true; manifest: Record<string, any> } | { ok: false; error: string }> {
  const r = await apps.slackCall('apps.manifest.export', { app_id: appId }, token);
  if (r.ok === true && r.manifest && typeof r.manifest === 'object') return { ok: true, manifest: r.manifest as Record<string, any> };
  return { ok: false, error: String(r.error ?? 'no reason given') };
}

const get = (o: any, path: string) => path.split('.').reduce((v, k) => (v == null ? undefined : v[k]), o);

/**
 * Read the live manifest, apply the changes, have Slack validate it, and with apply write it and read it back.
 * Without apply nothing is written: the answer is the change set and Slack's validation.
 */
export async function update(appId: string, c: Changes, opts: { apply: boolean }): Promise<UpdateResult> {
  if (!/^A[A-Z0-9]{6,}$/.test(appId)) return { ok: false, reason: 'bad_app_id', message: `"${appId}" is not a Slack app id (A…).`, app_id: appId };
  let token: string;
  try {
    token = await apps.configToken();
  } catch (e) {
    return { ok: false, reason: e instanceof apps.AppsError ? e.reason : 'token_failed', message: e instanceof Error ? e.message : String(e), app_id: appId };
  }
  const live = await exportManifest(appId, token);
  if (!live.ok) return { ok: false, reason: 'export_refused', message: `Slack would not export this app's manifest (${live.error}). Only an app Destiny collaborates on can be changed here.`, app_id: appId };

  const { manifest, changes, problems } = applyChanges(live.manifest, c);
  if (problems.length) return { ok: false, reason: 'invalid_changes', message: problems.join('; '), app_id: appId, changes, problems };
  if (!changes.length) return { ok: false, reason: 'nothing_to_change', message: 'The app already holds every value asked for.', app_id: appId };

  const v = await apps.slackCall('apps.manifest.validate', { app_id: appId, manifest: JSON.stringify(manifest) }, token);
  if (v.ok !== true) {
    const errs = Array.isArray(v.errors) ? (v.errors as Array<Record<string, unknown>>).map((e) => `${e.pointer ?? ''} ${e.message ?? ''}`.trim()) : [];
    return { ok: false, reason: 'slack_rejected', message: `Slack rejected the new manifest (${String(v.error ?? 'invalid')})${errs.length ? `: ${errs.join('; ')}` : ''}.`, app_id: appId, changes, problems: errs };
  }
  if (!opts.apply) return { ok: true, applied: false, app_id: appId, changes, permissions_updated: false, reinstall_needed: changes.some((x) => x.field === 'oauth_config.scopes.bot'), read_back: 'matches' };

  const u = await apps.slackCall('apps.manifest.update', { app_id: appId, manifest: JSON.stringify(manifest) }, token);
  if (u.ok !== true) {
    const errs = Array.isArray(u.errors) ? (u.errors as Array<Record<string, unknown>>).map((e) => `${e.pointer ?? ''} ${e.message ?? ''}`.trim()) : [];
    return { ok: false, reason: 'update_refused', message: `Slack refused the update (${String(u.error ?? 'no reason given')})${errs.length ? `: ${errs.join('; ')}` : ''}. Nothing changed.`, app_id: appId, changes, problems: errs };
  }
  const permissionsUpdated = u.permissions_updated === true;

  const back = await exportManifest(appId, token);
  const differs: string[] = [];
  if (!back.ok) differs.push(`could not read the manifest back (${back.error})`);
  else for (const ch of changes) {
    const now = get(back.manifest, ch.field);
    const held = ch.field === 'features.slash_commands' ? (Array.isArray(now) ? now.map((x: any) => x.command) : []) : now ?? null;
    if (JSON.stringify(held) !== JSON.stringify(ch.after)) differs.push(ch.field);
  }
  void apps.read({ by: 'update_slack_app' }).catch(() => undefined);
  return {
    ok: true,
    applied: true,
    app_id: appId,
    changes,
    permissions_updated: permissionsUpdated,
    reinstall_needed: permissionsUpdated,
    read_back: differs.length ? 'differs' : 'matches',
    ...(differs.length ? { differs } : {}),
  };
}
