/**
 * Setting up a channel Bays is already in but that the engine never set up (14 Oct 2026,
 * Destiny; Jason's review of the 13 Oct log, ask 1: "from half done to fully").
 *
 * A channel gets its Drive folder, daily doc and channel_tracking row when Bays joins it.
 * A channel Bays joined before that setup existed, or whose setup failed, has no row, so the
 * destination guard reads it as unknown and Bays cannot open a Decision Watch there. Until
 * now that was a refusal and a person had to fix it by hand.
 *
 * This runs the same setup on demand: n8n's `Bays — Channel Register` (d7Q7SKn0Q2CbAghj)
 * hands `Bays — Message Capture` the event a Bays join gives it, so there is one setup path,
 * never a second copy. It is only asked for a channel Slack says Bays is a member of, that is
 * not archived and not kept out on purpose. The 200 is never trusted alone: the row is read
 * back, and only a row that is there counts as registered.
 */
import * as slack from './slack';
import * as n8n from './n8n';
import { query } from './pg';

/** Kept out of the archive on purpose. #bha-pay-reviews: pay talk is not captured. */
const EXCLUDED_DEFAULT = ['C0C24D5PZQE'];
/** A channel whose name says it is a test or a leftover is never set up from here. */
const EXCLUDED_NAME = /^(test|tmp|old|archive|zz)[-_]/i;
const PATH = process.env.CHANNEL_REGISTER_PATH?.trim() || '/webhook/channel-register';
const TIMEOUT_MS = 60_000;

export type RegisterResult =
  | { ok: true; channel_id: string; name: string | null; dry_run: boolean; message: string }
  | { ok: false; reason: 'channel_excluded' | 'bays_not_in_channel' | 'channel_unreadable' | 'register_failed' | 'not_configured'; message: string };

function excluded(): string[] {
  const extra = (process.env.CHANNEL_REGISTER_EXCLUDED || '').split(',').map((x) => x.trim()).filter(Boolean);
  return [...EXCLUDED_DEFAULT, ...extra];
}

async function tracked(channel: string): Promise<boolean> {
  const r = await query(`SELECT 1 FROM engine_channel_tracking WHERE natural_id = $1 LIMIT 1`, [channel]);
  return r.rows.length > 0;
}

/**
 * Set up `channel` for capture. `dry_run` checks everything and calls nothing.
 * Every refusal says, step by step, what a person does instead.
 */
export async function register(channel: string, opts: { dry_run?: boolean; requested_by?: string | null } = {}): Promise<RegisterResult> {
  if (excluded().includes(channel)) {
    return { ok: false, reason: 'channel_excluded', message: `<#${channel}> is kept out of the engine's archive on purpose, so Bays does not set it up or post reminders there. Open this watch somewhere else, or a person can open it through the connector.` };
  }
  const info = await slack.botCall('conversations.info', { channel }, 'form');
  const ch = info.channel as { name?: string; is_member?: boolean; is_archived?: boolean } | undefined;
  if (!info.ok || !ch) {
    return { ok: false, reason: 'channel_unreadable', message: `Slack would not tell Bays about <#${channel}> (${String(info.error ?? 'no channel in the answer')}). To fix: 1) invite Bays to the channel with /invite @Bays, which sets it up; 2) ask again.` };
  }
  const name = ch.name ?? null;
  if (ch.is_archived) return { ok: false, reason: 'channel_excluded', message: `#${name ?? channel} is archived, so nothing is set up or reminded there.` };
  if (name && EXCLUDED_NAME.test(name)) return { ok: false, reason: 'channel_excluded', message: `#${name} is named as a test or leftover channel, so it is not set up from here. A person can open the watch through the connector.` };
  if (ch.is_member !== true) {
    return { ok: false, reason: 'bays_not_in_channel', message: `Bays is not a member of #${name ?? channel}. To fix: 1) in that channel, type /invite @Bays; 2) Bays sets the channel up when it joins (Drive folder, daily doc, tracking) and says so there; 3) ask again.` };
  }
  if (opts.dry_run) return { ok: true, channel_id: channel, name, dry_run: true, message: `#${name ?? channel} is not set up yet; a real call would set it up (Drive folder, daily doc, tracking) and then open the watch.` };

  const key = process.env.DASHBOARD_INBOUND_KEY?.trim();
  if (!key) return { ok: false, reason: 'not_configured', message: 'DASHBOARD_INBOUND_KEY is not set on this server, and the channel setup webhook is authenticated by it.' };
  const url = `${n8n.n8nHost()}${PATH}`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  let status = 0;
  let text = '';
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-dashboard-key': key },
      body: JSON.stringify({ channel_id: channel, requested_by: opts.requested_by ?? null }),
      signal: ctl.signal,
    });
    status = res.status;
    text = await res.text();
  } catch (e) {
    const msg = e instanceof Error ? (e.name === 'AbortError' ? `n8n did not answer within ${TIMEOUT_MS / 1000} seconds` : e.message) : String(e);
    // A slow answer may still have finished: the row decides.
    if (await tracked(channel)) return { ok: true, channel_id: channel, name, dry_run: false, message: `#${name ?? channel} is now set up (the setup answered late: ${msg}).` };
    return { ok: false, reason: 'register_failed', message: `Setting up #${name ?? channel} failed: ${msg}. To fix: 1) remove Bays from the channel and invite it again with /invite @Bays, which runs the same setup; 2) ask again.` };
  } finally {
    clearTimeout(timer);
  }
  let body: { ok?: boolean; error?: string } = {};
  try { body = JSON.parse(text); } catch { /* not JSON: the status decides */ }
  if (status < 200 || status >= 300 || body.ok !== true) {
    return { ok: false, reason: 'register_failed', message: `Setting up #${name ?? channel} failed: n8n answered ${status} (${body.error ?? (text.slice(0, 200) || 'no body')}). To fix: 1) remove Bays from the channel and invite it again with /invite @Bays; 2) ask again.` };
  }
  if (!(await tracked(channel))) {
    return { ok: false, reason: 'register_failed', message: `The setup for #${name ?? channel} answered, but no tracking row was written, so the channel is still not set up. To fix: 1) remove Bays from the channel and invite it again with /invite @Bays; 2) ask again.` };
  }
  return { ok: true, channel_id: channel, name, dry_run: false, message: `#${name ?? channel} was not set up; it is now (Drive folder, daily doc, tracking).` };
}
