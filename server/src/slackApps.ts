/**
 * The Slack apps on BHA's workspace, their slash commands and their bots, read from Slack (13 Nov 2026, Destiny:
 * "we need some sort of way to know all the apps that we have on our workspace and all the commands that each of
 * them have"). Built after /sample-command answered "app did not respond" in Kavin's log channel and nobody could say
 * which app owned it.
 *
 * Read only. Nothing here creates, changes or deletes an app, a command or a manifest.
 *
 * Two reads, each with its own credential:
 *   - **Which apps are installed**: `users.list` with the Bays bot token. Every app with a bot user is a bot user,
 *     and its profile carries the app id. An app with no bot user is not listed by Slack to anyone but a workspace
 *     admin on Enterprise, so it can be named by hand (`app_ids`) and is then read like the rest.
 *   - **What each app does**: `apps.manifest.export`, with an app configuration token. Slack only exports the
 *     manifest of an app the token's owner (Destiny) is a collaborator on; any other app is kept with Slack's own
 *     refusal, never left out.
 *
 * **The configuration token rotates.** It lasts 12 hours; `tooling.tokens.rotate` swaps the refresh token for a new
 * pair and kills the old refresh token. So `SLACK_CONFIG_REFRESH_TOKEN` on Render is used once, to seed, and the
 * live pair is kept in `meta` (`slack_config.tokens`), rotated under an advisory lock so two instances during a
 * deploy cannot both spend the same refresh token. When the variable on Render changes (a new pair was generated),
 * the stored pair is replaced from it. Neither token is ever returned by any route or tool.
 *
 * Every read lands in `engine_slack_apps`, one row per app (migration 133), and one `slack_apps_read` event. URLs in a
 * manifest keep their host and path and lose any query string, and the manifest goes through the secret redactor.
 */
import { createHash } from 'node:crypto';
import { getMeta, setMeta } from './db';
import { query, withTransaction } from './pg';
import * as slack from './slack';
import * as engineEvents from './engineEvents';
import { redactSecrets } from './dataGovernance';
import * as timers from './timers';

export const CONFIG_TOKEN_VAR = 'SLACK_CONFIG_TOKEN';
export const CONFIG_REFRESH_VAR = 'SLACK_CONFIG_REFRESH_TOKEN';
const API = process.env.SLACK_API_URL?.trim().replace(/\/+$/, '') || 'https://slack.com/api';
const META_KEY = 'slack_config.tokens';
const META_LAST = 'slack_apps.last_read';
const LOCK_KEY = 8_134_207_733;
const TIMEOUT_MS = 20_000;
/** A read is taken once a day by the timer, and at most once a minute on demand. */
export const RULE = { every_hours: 24, min_gap_seconds: 60 } as const;

type Stored = { access: string; refresh: string; exp: number; seeded_from: string; rotated_at: string };

export class AppsError extends Error {
  constructor(public reason: string, message: string) {
    super(message);
  }
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);

async function call(method: string, params: Record<string, string>, token?: string): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${API}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: new URLSearchParams(params).toString(),
      signal: controller.signal,
    });
    const text = await res.text();
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      return { ok: false, error: `http_${res.status}: ${text.slice(0, 200) || 'empty body'}` };
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error && e.name === 'AbortError' ? `timeout (${TIMEOUT_MS / 1000}s)` : `unreachable: ${e instanceof Error ? e.message : String(e)}` };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A configuration token good for at least ten more minutes. Rotates when it is not, under a lock, and stores the new
 * pair before using it. Throws AppsError with what to do when there is nothing to rotate with.
 */
export async function configToken(): Promise<string> {
  const envRefresh = process.env[CONFIG_REFRESH_VAR]?.trim() || null;
  return withTransaction(async (db) => {
    await db.query('SELECT pg_advisory_xact_lock($1)', [LOCK_KEY]);
    const raw = await getMeta(META_KEY, db);
    let held: Stored | null = null;
    try {
      held = raw ? (JSON.parse(raw) as Stored) : null;
    } catch {
      held = null;
    }
    // A new pair put on Render replaces what is held: somebody generated it on purpose.
    const reseed = envRefresh && (!held || held.seeded_from !== sha(envRefresh));
    const now = Math.floor(Date.now() / 1000);
    if (held && !reseed && held.exp - now > 600) return held.access;
    const refresh = reseed ? envRefresh : held?.refresh ?? null;
    if (!refresh) throw new AppsError('not_configured', `${CONFIG_REFRESH_VAR} is not set on this server, so no app's manifest can be read. Generate an app configuration token pair at api.slack.com/apps (Your App Configuration Tokens) and put the refresh token in ${CONFIG_REFRESH_VAR} on Render.`);
    const r = await call('tooling.tokens.rotate', { refresh_token: refresh });
    if (r.ok !== true || typeof r.token !== 'string' || typeof r.refresh_token !== 'string') {
      throw new AppsError('rotate_refused', `Slack refused to rotate the app configuration token (${String(r.error ?? 'no reason given')}). The held refresh token is spent or revoked: generate a new pair at api.slack.com/apps (Your App Configuration Tokens) and put the new refresh token in ${CONFIG_REFRESH_VAR} on Render.`);
    }
    const next: Stored = {
      access: r.token,
      refresh: r.refresh_token,
      exp: Number(r.exp) || now + 12 * 3600,
      seeded_from: reseed && envRefresh ? sha(envRefresh) : held?.seeded_from ?? '',
      rotated_at: new Date().toISOString(),
    };
    await setMeta(META_KEY, JSON.stringify(next), db);
    return next.access;
  });
}

/** Whether a configuration token is held or can be seeded, and when it last rotated. Never the token. */
export async function tokenState(): Promise<{ configured: boolean; rotated_at: string | null; expires_at: string | null }> {
  const raw = await getMeta(META_KEY).catch(() => null);
  let held: Stored | null = null;
  try {
    held = raw ? (JSON.parse(raw) as Stored) : null;
  } catch {
    held = null;
  }
  return {
    configured: Boolean(held || process.env[CONFIG_REFRESH_VAR]?.trim()),
    rotated_at: held?.rotated_at ?? null,
    expires_at: held ? new Date(held.exp * 1000).toISOString() : null,
  };
}

/** A URL keeps its host and path; a query string or fragment goes. Pure. */
export function cleanUrl(u: string): string {
  const m = u.match(/^(https?:\/\/[^?#\s]+)([?#]\S*)?$/i);
  if (!m) return u;
  return m[2] ? `${m[1]}?[query removed]` : m[1];
}

/** Every string in a manifest that is a URL is cleaned, then the whole thing is redacted. Pure. */
export function cleanManifest(m: unknown): unknown {
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return /^https?:\/\//i.test(v) ? cleanUrl(v) : v;
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return JSON.parse(redactSecrets(JSON.stringify(walk(m))).text);
}

export type Command = { command: string; description: string | null; usage_hint: string | null; url: string | null; delivery: 'request_url' | 'socket_mode' | 'none' };

/** The parts of a manifest a person asks about. Pure. */
export function summarise(manifest: Record<string, any>): {
  name: string | null;
  description: string | null;
  commands: Command[];
  socket_mode: boolean;
  event_url: string | null;
  interactivity_url: string | null;
  bot_scopes: string[];
  user_scopes: string[];
  bot_events: string[];
} {
  const settings = manifest.settings ?? {};
  const socket = settings.socket_mode_enabled === true;
  const cmds: Command[] = (Array.isArray(manifest.features?.slash_commands) ? manifest.features.slash_commands : []).map((c: Record<string, unknown>) => {
    const url = typeof c.url === 'string' && c.url ? c.url : null;
    return {
      command: String(c.command ?? ''),
      description: typeof c.description === 'string' ? c.description : null,
      usage_hint: typeof c.usage_hint === 'string' ? c.usage_hint : null,
      url,
      delivery: url ? 'request_url' : socket ? 'socket_mode' : 'none',
    };
  });
  const arr = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
  return {
    name: manifest.display_information?.name ?? null,
    description: manifest.display_information?.description ?? null,
    commands: cmds,
    socket_mode: socket,
    event_url: settings.event_subscriptions?.request_url ?? null,
    interactivity_url: settings.interactivity?.request_url ?? null,
    bot_scopes: arr(manifest.oauth_config?.scopes?.bot),
    user_scopes: arr(manifest.oauth_config?.scopes?.user),
    bot_events: arr(settings.event_subscriptions?.bot_events),
  };
}

type Listed = { app_id: string; name: string; bot_user_id: string; bot_id: string | null; deleted: boolean };

/** Every bot user on the workspace that carries an app id, via the Bays bot's users.list. */
async function listApps(): Promise<Listed[]> {
  const token = process.env[slack.SLACK_TOKEN_VAR]?.trim();
  if (!token) throw new AppsError('not_configured', `${slack.SLACK_TOKEN_VAR} is not set, so the apps on the workspace cannot be listed.`);
  const out = new Map<string, Listed>();
  let cursor = '';
  for (let page = 0; page < 20; page++) {
    const r = await call('users.list', { limit: '200', ...(cursor ? { cursor } : {}) }, token);
    if (r.ok !== true) throw new AppsError('list_refused', `Slack refused to list the workspace's users with the Bays bot token (${String(r.error ?? 'no reason')}), so the apps could not be listed. The token needs users:read.`);
    for (const u of (r.members as Array<Record<string, any>>) ?? []) {
      const appId = u.profile?.api_app_id;
      if (!u.is_bot || !appId) continue;
      const prev = out.get(appId);
      // One app has one bot user; if Slack lists a deleted one beside a live one, the live one wins.
      if (prev && !prev.deleted) continue;
      out.set(appId, { app_id: appId, name: u.real_name || u.profile?.real_name || u.name, bot_user_id: u.id, bot_id: u.profile?.bot_id ?? null, deleted: u.deleted === true });
    }
    cursor = String((r.response_metadata as Record<string, unknown> | undefined)?.next_cursor ?? '');
    if (!cursor) break;
  }
  return [...out.values()];
}

/** Which of the engine's bots each bot user is, by auth.test on the tokens this server holds. */
async function engineBots(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const toks: [string, string | null][] = [
    ['Bays', process.env[slack.SLACK_TOKEN_VAR]?.trim() || null],
    ['North Star', slack.northStarToken()],
    ['Research Twin', slack.researchTwinToken()],
  ];
  for (const [name, t] of toks) {
    if (!t) continue;
    const r = await call('auth.test', {}, t);
    if (r.ok === true && typeof r.user_id === 'string') out.set(r.user_id, name);
  }
  return out;
}

let lastRun = 0;
let running: Promise<ReadResult> | null = null;

export type ReadResult = {
  ok: boolean;
  reason?: string;
  message?: string;
  apps: number;
  readable: number;
  not_readable: number;
  commands: number;
  gone: number;
  at: string;
};

/**
 * Reads every app from Slack and stores it. `extra` names app ids Slack does not list (no bot user). Never two at
 * once; on demand at most once a minute (a second call inside the minute is told when the last one ran).
 */
export async function read(opts: { extra?: string[]; by?: string } = {}): Promise<ReadResult> {
  if (running) return running;
  const gap = Math.round((Date.now() - lastRun) / 1000);
  if (lastRun && gap < RULE.min_gap_seconds) {
    return { ok: false, reason: 'too_soon', message: `Slack was read ${gap} seconds ago; the list on the page is that read.`, apps: 0, readable: 0, not_readable: 0, commands: 0, gone: 0, at: new Date().toISOString() };
  }
  lastRun = Date.now();
  running = doRead(opts).finally(() => (running = null));
  return running;
}

async function doRead(opts: { extra?: string[]; by?: string }): Promise<ReadResult> {
  const at = new Date().toISOString();
  const empty = { apps: 0, readable: 0, not_readable: 0, commands: 0, gone: 0, at };
  let listed: Listed[];
  try {
    listed = await listApps();
  } catch (e) {
    const err = e instanceof AppsError ? e : new AppsError('list_failed', String(e));
    await setMeta(META_LAST, JSON.stringify({ at, ok: false, reason: err.reason, message: err.message })).catch(() => undefined);
    return { ok: false, reason: err.reason, message: err.message, ...empty };
  }
  const extra = (opts.extra ?? []).map((s) => s.trim().toUpperCase()).filter((s) => /^A[A-Z0-9]{6,}$/.test(s) && !listed.some((l) => l.app_id === s));
  // Apps named by hand before stay named by hand.
  const handHeld = await query<{ app_id: string }>(`SELECT app_id FROM engine_slack_apps WHERE bot_user_id IS NULL`).catch(() => ({ rows: [] as { app_id: string }[] }));
  const byHand = [...new Set([...extra, ...handHeld.rows.map((r) => r.app_id)])].filter((id) => !listed.some((l) => l.app_id === id));

  let token: string | null = null;
  let tokenErr: AppsError | null = null;
  try {
    token = await configToken();
  } catch (e) {
    tokenErr = e instanceof AppsError ? e : new AppsError('token_failed', String(e));
  }
  const bots = await engineBots().catch(() => new Map<string, string>());

  let readable = 0;
  let commands = 0;
  const targets: Array<Listed | { app_id: string; name: null; bot_user_id: null; bot_id: null; deleted: false }> = [
    ...listed,
    ...byHand.map((app_id) => ({ app_id, name: null, bot_user_id: null, bot_id: null, deleted: false as const })),
  ];
  for (const t of targets) {
    let manifest: Record<string, any> | null = null;
    let readErr: string | null = null;
    if (!token) readErr = tokenErr?.message ?? 'no configuration token';
    else {
      const r = await call('apps.manifest.export', { app_id: t.app_id }, token);
      if (r.ok === true && r.manifest && typeof r.manifest === 'object') manifest = cleanManifest(r.manifest) as Record<string, any>;
      else readErr = `Slack would not export this app's manifest: ${String(r.error ?? 'no reason given')}${r.error === 'no_permission' || r.error === 'not_allowed' ? ' (Destiny is not a collaborator on this app, so only its owner can read it)' : r.error === 'app_not_found' || r.error === 'invalid_app' ? ' (Slack has no app under this id: its bot user is left over from an app that was deleted or rebuilt)' : ''}`;
    }
    const s = manifest ? summarise(manifest) : null;
    if (s) {
      readable++;
      commands += s.commands.length;
    }
    await query(
      `INSERT INTO engine_slack_apps (app_id, name, bot_user_id, bot_id, engine_bot, listed, deleted, readable, read_error, manifest,
         description, commands, socket_mode, event_url, interactivity_url, bot_scopes, user_scopes, bot_events, listed_at, read_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20, now())
       ON CONFLICT (app_id) DO UPDATE SET
         name = COALESCE(excluded.name, engine_slack_apps.name),
         bot_user_id = excluded.bot_user_id, bot_id = excluded.bot_id, engine_bot = excluded.engine_bot,
         listed = excluded.listed, deleted = excluded.deleted, readable = excluded.readable, read_error = excluded.read_error,
         manifest = COALESCE(excluded.manifest, engine_slack_apps.manifest),
         description = COALESCE(excluded.description, engine_slack_apps.description),
         commands = CASE WHEN excluded.readable THEN excluded.commands ELSE engine_slack_apps.commands END,
         socket_mode = COALESCE(excluded.socket_mode, engine_slack_apps.socket_mode),
         event_url = CASE WHEN excluded.readable THEN excluded.event_url ELSE engine_slack_apps.event_url END,
         interactivity_url = CASE WHEN excluded.readable THEN excluded.interactivity_url ELSE engine_slack_apps.interactivity_url END,
         bot_scopes = CASE WHEN excluded.readable THEN excluded.bot_scopes ELSE engine_slack_apps.bot_scopes END,
         user_scopes = CASE WHEN excluded.readable THEN excluded.user_scopes ELSE engine_slack_apps.user_scopes END,
         bot_events = CASE WHEN excluded.readable THEN excluded.bot_events ELSE engine_slack_apps.bot_events END,
         listed_at = COALESCE(excluded.listed_at, engine_slack_apps.listed_at),
         read_at = CASE WHEN excluded.readable THEN excluded.read_at ELSE engine_slack_apps.read_at END,
         gone_at = NULL, updated_at = now()`,
      [
        t.app_id,
        s?.name ?? t.name,
        t.bot_user_id,
        t.bot_id,
        t.bot_user_id ? bots.get(t.bot_user_id) ?? null : null,
        Boolean(t.bot_user_id),
        t.deleted,
        Boolean(s),
        readErr,
        manifest ? JSON.stringify(manifest) : null,
        s?.description ?? null,
        JSON.stringify(s?.commands ?? []),
        s ? s.socket_mode : null,
        s?.event_url ?? null,
        s?.interactivity_url ?? null,
        JSON.stringify(s?.bot_scopes ?? []),
        JSON.stringify(s?.user_scopes ?? []),
        JSON.stringify(s?.bot_events ?? []),
        t.bot_user_id ? at : null,
        s ? at : null,
      ],
    );
  }
  // An app this read did not find is kept and marked gone, never deleted: it was there.
  const ids = targets.map((t) => t.app_id);
  const gone = await query(`UPDATE engine_slack_apps SET gone_at = COALESCE(gone_at, now()), listed = false, updated_at = now() WHERE NOT (app_id = ANY($1::text[])) RETURNING app_id`, [ids]);
  const result: ReadResult = { ok: true, apps: targets.length, readable, not_readable: targets.length - readable, commands, gone: gone.rowCount ?? 0, at };
  if (tokenErr) Object.assign(result, { reason: tokenErr.reason, message: `The apps were listed, but no manifest could be read: ${tokenErr.message}` });
  await setMeta(META_LAST, JSON.stringify({ ...result, by: opts.by ?? null })).catch(() => undefined);
  await engineEvents
    .record({ event_type: 'slack_apps_read', subject_id: 'slack_workspace', lane: 'BAYS', actor: opts.by ?? 'dashboard', source_ref: 'apps.manifest.export', detail: { ...result } })
    .catch((e) => console.error(`[slack-apps] event not written: ${(e as Error).message}`));
  return result;
}

/**
 * Which kind of app a row is (13 Nov 2026, Destiny). Worked out from what Slack said, plus one list of the
 * marketplace tools the team installed, which nothing Slack returns to a bot can tell apart from a custom app.
 *   bha         an app Destiny collaborates on (its manifest was read)
 *   checkin     the morning and evening check-in apps, which post the check-in prompts and carry no commands
 *   team        a custom app somebody on the team built, that Destiny is not a collaborator on
 *   leftover    a bot user whose app Slack no longer has (deleted or rebuilt)
 *   third_party a marketplace tool
 */
export type AppGroup = 'bha' | 'checkin' | 'team' | 'leftover' | 'third_party';
export const THIRD_PARTY_APPS: Record<string, string> = {
  A097V82EGG2: 'ChatGPT',
  A08SF47R6P4: 'Claude',
  A08SKDT6QUW: 'Cursor',
  A01BP7R4KNY: 'GitHub',
  A09K54AJYMT: 'LangSmith Fleet',
  A077GAL0CMA: 'Latenode',
  A049JV0H0KC: 'Notion',
  A04ULDS8UFN: 'Otter.ai',
  ASCEKRJF6: 'Render',
  A024R9PQM: 'Zapier',
};
export function groupOf(a: { app_id: string; name: string | null; readable: boolean; read_error: string | null }): AppGroup {
  if (THIRD_PARTY_APPS[a.app_id]) return 'third_party';
  if (a.readable) return /check-?in/i.test(a.name ?? '') ? 'checkin' : 'bha';
  if (/app_not_found|invalid_app/.test(a.read_error ?? '')) return 'leftover';
  return 'team';
}

export type AppRow = {
  app_id: string;
  name: string | null;
  description: string | null;
  bot_user_id: string | null;
  engine_bot: string | null;
  listed: boolean;
  deleted: boolean;
  readable: boolean;
  read_error: string | null;
  commands: Command[];
  socket_mode: boolean | null;
  event_url: string | null;
  interactivity_url: string | null;
  bot_scopes: string[];
  user_scopes: string[];
  bot_events: string[];
  first_seen_at: string;
  listed_at: string | null;
  read_at: string | null;
  gone_at: string | null;
  group?: AppGroup;
};

/** What the page and the tool show: every app held, every command flat, and commands two apps both claim. */
export async function show(): Promise<{
  apps: AppRow[];
  commands: Array<Command & { app_id: string; app: string | null; engine_bot: string | null; installed: boolean }>;
  shared_commands: Array<{ command: string; apps: string[] }>;
  last_read: Record<string, unknown> | null;
  token: Awaited<ReturnType<typeof tokenState>>;
  note: string;
}> {
  const r = await query<AppRow>(
    `SELECT app_id, name, description, bot_user_id, engine_bot, listed, deleted, readable, read_error, commands, socket_mode, event_url,
            interactivity_url, bot_scopes, user_scopes, bot_events, first_seen_at, listed_at, read_at, gone_at
       FROM engine_slack_apps ORDER BY (gone_at IS NOT NULL), deleted, lower(COALESCE(name, app_id))`,
  );
  const apps = r.rows.map((a) => ({ ...a, group: groupOf(a) }));
  const commands = apps.flatMap((a) => (a.commands ?? []).map((c) => ({ ...c, app_id: a.app_id, app: a.name, engine_bot: a.engine_bot, installed: a.listed && !a.deleted && !a.gone_at })));
  const byName = new Map<string, string[]>();
  for (const c of commands.filter((c) => c.installed)) byName.set(c.command.toLowerCase(), [...(byName.get(c.command.toLowerCase()) ?? []), c.app ?? c.app_id]);
  const shared_commands = [...byName.entries()].filter(([, a]) => a.length > 1).map(([command, a]) => ({ command, apps: a }));
  const lastRaw = await getMeta(META_LAST).catch(() => null);
  let last_read: Record<string, unknown> | null = null;
  try {
    last_read = lastRaw ? (JSON.parse(lastRaw) as Record<string, unknown>) : null;
  } catch {
    last_read = null;
  }
  return {
    apps,
    commands,
    shared_commands,
    last_read,
    token: await tokenState(),
    note: 'Read from Slack, never typed. An app is listed when it has a bot user; one with none can be added by its app id. A manifest is read only for an app Destiny is a collaborator on; any other app is shown with the reason Slack gave. Nothing here changes an app.',
  };
}

let timer: NodeJS.Timeout | null = null;
/** Once a day, so the list never goes stale by more than a day and the refresh token keeps rotating. */
export function startReading(): void {
  if (timer) return;
  const tick = async () => {
    timers.beat('slack apps read');
    const raw = await getMeta(META_LAST).catch(() => null);
    const lastAt = raw ? Date.parse((JSON.parse(raw) as { at?: string }).at ?? '') : NaN;
    if (Number.isFinite(lastAt) && Date.now() - lastAt < RULE.every_hours * 3600_000) return;
    const r = await read({ by: 'timer' });
    console.log(`[slack-apps] ${r.ok ? `read ${r.apps} app(s), ${r.readable} manifest(s), ${r.commands} command(s), ${r.gone} gone` : `read failed: ${r.reason} ${r.message}`}`);
  };
  setTimeout(() => void tick().catch((e) => console.error(`[slack-apps] ${(e as Error).message}`)), 90_000).unref();
  timer = setInterval(() => void tick().catch((e) => console.error(`[slack-apps] ${(e as Error).message}`)), 3600_000);
  timer.unref();
}
