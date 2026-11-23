/**
 * Posting to Slack as Genie (23 Nov 2026, Destiny: "let's use Genie's Slack id for sending the reminders").
 * This dashboard holds no Genie bot token, so it asks Genie to post on POST /api/genie/post-card with the
 * inbound key Genie already holds. Moved here from rssReports.ts so the Decision Watch reminders, escalations
 * and combined DMs can use it too.
 */
/**
 * The BHA RSS cards are Genie's (16 Nov 2026, Destiny: "Bays posted it instead of Genie"; RSS is a
 * Genie subsystem): this dashboard holds no Genie bot token, so it asks Genie to post them, on POST /api/genie/post-card with the inbound key
 * Genie already holds. A post Genie cannot make is a failure, never handed to Bays instead.
 */
export async function postAsGenie(channel: string, text: string, blocks: unknown[], updateTs?: string, extra?: { thread_ts?: string; guarded?: boolean }): Promise<{ ok: true; ts: string; channel?: string } | { ok: false; error: string }> {
  const key = process.env.DASHBOARD_INBOUND_KEY?.trim();
  if (!key) return { ok: false, error: 'DASHBOARD_INBOUND_KEY is not set, so Genie cannot be asked to post' };
  const url = `${(process.env.GENIE_URL || 'https://genie-v3-migration-u82u.onrender.com').replace(/\/+$/, '')}/api/genie/post-card`;
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dashboard-key': key }, body: JSON.stringify({ channel, text, blocks, ...(updateTs ? { update_ts: updateTs } : {}), ...(extra?.thread_ts ? { thread_ts: extra.thread_ts } : {}), ...(extra?.guarded ? { guarded: true } : {}) }), signal: AbortSignal.timeout(20_000) });
    const j = (await res.json().catch(() => ({}))) as { ok?: boolean; ts?: string; channel?: string; error?: string };
    if (res.ok && j.ok && typeof j.ts === 'string') return { ok: true, ts: j.ts, ...(typeof j.channel === 'string' ? { channel: j.channel } : {}) };
    return { ok: false, error: `Genie did not post it (HTTP ${res.status}): ${String(j.error ?? 'no reason given')}` };
  } catch (e) {
    return { ok: false, error: `Genie could not be reached: ${e instanceof Error ? e.message : String(e)}` };
  }
}

