/**
 * Genie's ledger skip warning gets a reader (10 Nov 2026, Destiny — LOOP-1793889625530-M5YH, from
 * Kaiqi's 5 Nov log CODEX-20261105-kaiqi-yang-anthropic-frontdoor-migration).
 *
 * When Genie's `bha_ledger_query` has no direct ledger read for a workspace, it falls back to asking
 * the agent and writes one line to its own log:
 *   bha_ledger_query: ledger GET not configured for "rss-feed"; using ask_agent requestId=<uuid>
 * and its per-run "builder run record" carries the same thing in `skipWarns`. Until this, nothing read
 * either: Research Twin said on 5 Nov that it reads no Render logs, and a warning nobody reads is a
 * silent fallback.
 *
 * Every 15 minutes this reads Genie's Render log (u82u, `RENDER_READ_KEY`, the read the service
 * reads already use) from where it last stopped, and writes one `genie_ledger_skip_warn` engine event
 * per request and workspace, so Genie, Bays and the twins read them with `read_engine_events`. When
 * one workspace falls back `RULE.alert_count` times in `RULE.window_days` days, one alert goes to the
 * engine alerts channel as Bays, naming the workspace and the request ids, for Genie's owner to add
 * the missing read or say the fallback is intended. Once per workspace per window: the claim is an
 * engine event written before the post, and a post Slack refuses gives the claim back.
 *
 * Not Research Twin: a missing ledger setting is not an outside-world question. It reads and posts;
 * it changes nothing on Genie. A log Render will not give is logged and the cursor stays, so the
 * next pass reads the same span again; a fallback is never dropped because a read failed.
 */
import { query } from './pg';
import { getMeta, setMeta } from './db';
import { record } from './engineEvents';
import * as serviceReads from './serviceReads';
import * as slack from './slack';
import * as quota from './quota';
import * as timers from './timers';

export const RULE = { tick_minutes: 15, window_days: 7, alert_count: 3, first_read_days: 29, max_pages: 20 } as const;
export const CURSOR_KEY = 'genie_skip_warn.cursor';
export const EVENT = 'genie_ledger_skip_warn';
export const ALERT_EVENT = 'genie_skip_warn_alerted';
/** Genie u82u, the Slack-connected service, and BHA's Render workspace. Not secrets; overridable. */
export const genieService = () => (process.env.GENIE_RENDER_SERVICE_ID || 'srv-dahmtfbm8hqs73cgohkg').trim();
export const renderOwner = () => (process.env.RENDER_OWNER_ID || 'tea-dafco81t0dsc73djsv4g').trim();
/** What Render is asked for: the warning line, and run records whose skipWarns is not empty. */
export const PATTERNS = ['*ledger GET not configured*', '*"skipWarns":[{*'];

export interface SkipWarn { workspace: string; request_id: string | null; fallback: string | null; log_id: string; at: string; source: 'warn_line' | 'run_record'; line: string }
export interface LogLine { id: string; message: string; timestamp: string }

const WARN = /ledger GET not configured for "([^"]+)"(?:;\s*using\s+([A-Za-z_]+))?(?:.*?requestId=([0-9a-fA-F-]{8,}))?/;

/** Pure: the skip warnings one Render log line carries (none, one, or several from a run record). */
export function parse(l: LogLine): SkipWarn[] {
  const msg = String(l.message ?? '');
  const m = WARN.exec(msg);
  if (m) return [{ workspace: m[1], fallback: m[2] ?? null, request_id: m[3] ?? null, log_id: l.id, at: l.timestamp, source: 'warn_line', line: msg.slice(0, 300) }];
  if (!msg.includes('skipWarns')) return [];
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(msg);
  } catch {
    return [];
  }
  const run = (j.builderRun ?? j) as Record<string, unknown>;
  const warns = Array.isArray(run.skipWarns) ? run.skipWarns : [];
  const rid = typeof run.requestId === 'string' ? run.requestId : null;
  const out: SkipWarn[] = [];
  for (const w of warns) {
    const o = (w && typeof w === 'object' ? w : { message: String(w) }) as Record<string, unknown>;
    const text = typeof o.message === 'string' ? o.message : typeof w === 'string' ? w : JSON.stringify(o);
    const inner = WARN.exec(text);
    const ws = [o.workspace, o.slug, o.workspaceSlug, inner?.[1]].find((v) => typeof v === 'string' && v) as string | undefined;
    out.push({
      workspace: ws ?? 'unknown',
      fallback: (typeof o.fallback === 'string' ? o.fallback : inner?.[2]) ?? null,
      request_id: (typeof o.requestId === 'string' ? o.requestId : rid) ?? null,
      log_id: l.id,
      at: l.timestamp,
      source: 'run_record',
      line: text.slice(0, 300),
    });
  }
  return out;
}

/** Pure: one event per request and workspace, so a warn line and its run record count once. */
export const dedupeKey = (w: SkipWarn) => (w.request_id ? `${EVENT}:${w.request_id}:${w.workspace}` : `${EVENT}:log:${w.log_id}`);

/** Pure: which workspaces crossed the line, from [{workspace, n, request_ids}]. */
export function crossings(rows: Array<{ workspace: string; n: number; request_ids: string[] }>): Array<{ workspace: string; n: number; request_ids: string[] }> {
  return rows.filter((r) => r.n >= RULE.alert_count).sort((a, b) => b.n - a.n || a.workspace.localeCompare(b.workspace));
}

/** Pure: the alert text. */
export function alertText(c: { workspace: string; n: number; request_ids: string[] }): string {
  const ids = c.request_ids.slice(0, 10).map((r) => `\`${r}\``).join(', ');
  const more = c.request_ids.length > 10 ? ` and ${c.request_ids.length - 10} more` : '';
  return [
    `*Genie keeps falling back on the "${c.workspace}" ledger*`,
    `In the last ${RULE.window_days} days Genie's ledger query found no direct read for "${c.workspace}" ${c.n} times and asked the agent instead.`,
    ids ? `Requests: ${ids}${more}.` : 'None of these lines carried a request id.',
    `Genie's owner: add the ledger read for "${c.workspace}", or say here that the fallback is intended. Each one is on the engine events as ${EVENT}.`,
    'Nothing was changed on Genie.',
  ].join('\n');
}

type Fetcher = typeof fetch;

/** Reads Genie's log for one pattern between two times, every page. */
async function readLogs(pattern: string, start: string, end: string, fetcher: Fetcher): Promise<{ ok: true; lines: LogLine[] } | { ok: false; error: string }> {
  const t = serviceReads.target('render', '/logs');
  if ('missing' in t) return { ok: false, error: `${t.missing} is not set, so Genie's log cannot be read` };
  const lines: LogLine[] = [];
  let s = start;
  let e = end;
  for (let page = 0; page < RULE.max_pages; page++) {
    const qs = new URLSearchParams({ ownerId: renderOwner(), resource: genieService(), text: pattern, limit: '100', startTime: s, endTime: e, direction: 'backward' });
    let body: { hasMore?: boolean; logs?: LogLine[]; nextStartTime?: string; nextEndTime?: string };
    try {
      const r = await fetcher(`${t.url}?${qs}`, { headers: t.headers, signal: AbortSignal.timeout(serviceReads.TIMEOUT_MS) });
      if (!r.ok) return { ok: false, error: `Render answered ${r.status} to the log read` };
      body = (await r.json()) as typeof body;
    } catch (err) {
      return { ok: false, error: `Render could not be reached: ${err instanceof Error ? err.message : String(err)}` };
    }
    for (const l of body.logs ?? []) lines.push({ id: l.id, message: l.message, timestamp: l.timestamp });
    if (!body.hasMore || !body.nextEndTime) return { ok: true, lines };
    s = body.nextStartTime ?? s;
    e = body.nextEndTime;
  }
  return { ok: false, error: `more than ${RULE.max_pages} pages of log in one span; the cursor stays so the next pass reads it again` };
}

async function post(text: string): Promise<{ ok: true; channel: string; ts: string } | { ok: false; error: string }> {
  const channel = quota.channelId();
  if (!channel) return { ok: false, error: `${quota.CHANNEL_VAR} is not set, so there is nowhere to post the alert` };
  if (!slack.slackConfigured()) return { ok: false, error: `${slack.SLACK_TOKEN_VAR} is not set, so nothing can be posted` };
  const r = await slack.botCall('chat.postMessage', { channel, text, unfurl_links: false, unfurl_media: false });
  if (r.ok && typeof r.ts === 'string') return { ok: true, channel: typeof r.channel === 'string' ? r.channel : channel, ts: r.ts };
  return { ok: false, error: `Slack refused the alert: ${String(r.error ?? 'unknown error')}` };
}

export interface PassResult { ok: boolean; read_from: string; read_to: string; lines: number; recorded: number; already: number; alerted: string[]; alert_failed: string[]; error?: string }

/** One pass. Never throws. `fetcher` and `now` are for the tests. */
export async function pass(opts: { now?: Date; fetcher?: Fetcher; post?: typeof post } = {}): Promise<PassResult> {
  const now = opts.now ?? new Date();
  const to = now.toISOString();
  const held = await getMeta(CURSOR_KEY);
  const floor = new Date(now.getTime() - RULE.first_read_days * 86_400_000).toISOString();
  const from = held && held > floor ? held : floor;
  const out: PassResult = { ok: true, read_from: from, read_to: to, lines: 0, recorded: 0, already: 0, alerted: [], alert_failed: [] };
  try {
    const seen = new Set<string>();
    for (const p of PATTERNS) {
      const r = await readLogs(p, from, to, opts.fetcher ?? fetch);
      if (!r.ok) {
        out.ok = false;
        out.error = r.error;
        console.error(`[genie-skip-warn] ${r.error}`);
        return out;
      }
      for (const l of r.lines) {
        if (seen.has(l.id)) continue;
        seen.add(l.id);
        out.lines++;
        for (const w of parse(l)) {
          const res = await record({
            event_type: EVENT,
            at: w.at,
            subject_id: w.request_id ?? `render-log:${w.log_id}`,
            lane: 'GENIE',
            actor: 'the dashboard (Genie log watch)',
            source_ref: `https://dashboard.render.com/web/${genieService()}/logs`,
            detail: { workspace: w.workspace, request_id: w.request_id, fallback: w.fallback, render_log_id: w.log_id, source: w.source, line: w.line },
            dedupe_key: dedupeKey(w),
          });
          if (res.recorded) out.recorded++;
          else out.already++;
        }
      }
    }
    // Every log span was read, so the cursor moves. A failed read above returned before this.
    await setMeta(CURSOR_KEY, to);

    const since = new Date(now.getTime() - RULE.window_days * 86_400_000).toISOString();
    const rows = (
      await query<{ workspace: string; n: number; request_ids: string[] }>(
        `SELECT detail->>'workspace' AS workspace, count(*)::int AS n,
                coalesce(array_agg(detail->>'request_id' ORDER BY at DESC) FILTER (WHERE detail->>'request_id' IS NOT NULL), '{}') AS request_ids
           FROM engine_events WHERE event_type = $1 AND at >= $2 GROUP BY 1`,
        [EVENT, since],
      )
    ).rows;
    const bucket = Math.floor(now.getTime() / (RULE.window_days * 86_400_000));
    for (const c of crossings(rows)) {
      const claim = await record({
        event_type: ALERT_EVENT,
        subject_id: c.workspace,
        lane: 'GENIE',
        actor: 'the dashboard (Genie log watch)',
        detail: { workspace: c.workspace, count: c.n, window_days: RULE.window_days, request_ids: c.request_ids.slice(0, 20) },
        dedupe_key: `${ALERT_EVENT}:${c.workspace}:${bucket}`,
      });
      if (!claim.recorded) continue;
      const p = await (opts.post ?? post)(alertText(c));
      if (p.ok) {
        await query(`UPDATE engine_events SET detail = detail || $2::jsonb WHERE id = $1`, [claim.id, JSON.stringify({ channel: p.channel, ts: p.ts })]);
        out.alerted.push(c.workspace);
      } else {
        // Give the claim back so the next pass tries again; never leave an alert nobody received.
        await query(`DELETE FROM engine_events WHERE id = $1`, [claim.id]);
        out.alert_failed.push(c.workspace);
        console.error(`[genie-skip-warn] alert for "${c.workspace}" not posted: ${p.error}`);
      }
    }
  } catch (e) {
    out.ok = false;
    out.error = e instanceof Error ? e.message : String(e);
    console.error(`[genie-skip-warn] pass failed: ${out.error}`);
  }
  return out;
}

let started = false;
let busy = false;
export function startWatching(): void {
  if (started) return;
  started = true;
  const tick = () => {
    timers.beat('genie skip-warn watch');
    if (busy) return;
    busy = true;
    pass()
      .then((r) => {
        if (r.recorded || r.alerted.length) console.log(`[genie-skip-warn] ${r.recorded} recorded, ${r.already} already held, alerted: ${r.alerted.join(', ') || 'none'}`);
      })
      .finally(() => (busy = false));
  };
  setTimeout(tick, 120_000).unref();
  setInterval(tick, RULE.tick_minutes * 60_000).unref();
}
