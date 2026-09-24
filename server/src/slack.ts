/**
 * Slack, as the Bays bot, for two things only (2026-09-24, Destiny):
 * downloading a file somebody shared with Bays (`read_slack_file`) and the DM
 * `grant_drive_access` sends Destiny when it refuses an address outside
 * bhanetwork.org.
 *
 * **`SLACK_BAYS_BOT_TOKEN`**, the Bays app's bot token (`xoxb-`), with no
 * default. Unset, both answer not-configured and name the variable. The
 * browser never sees it; like every other credential here it is only in the
 * server's environment.
 *
 * This is not a Slack integration. Nothing here reads channels, posts to one,
 * or listens for events — n8n does all of that. These are two calls.
 */
export const SLACK_TOKEN_VAR = 'SLACK_BAYS_BOT_TOKEN';
const TIMEOUT_MS = 20_000;
/** A file past this is refused rather than pulled whole into a 512 MB process. */
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
/**
 * Optional, and only for a local stand-in (the tests): `SLACK_API_URL` replaces
 * https://slack.com/api and `SLACK_FILES_ORIGIN` the origin a file is fetched
 * from. The **check** on the caller's url never moves — it must still be
 * https://files.slack.com/ — only where the download is sent.
 */
const API = process.env.SLACK_API_URL?.trim().replace(/\/+$/, '') || 'https://slack.com/api';
const FILES_ORIGIN = process.env.SLACK_FILES_ORIGIN?.trim().replace(/\/+$/, '') || null;

function token(): string | null {
  return process.env[SLACK_TOKEN_VAR]?.trim() || null;
}

export function slackConfigured(): boolean {
  return token() !== null;
}

/** The one host a Slack file is served from. Checked on the parsed URL, not a prefix. */
export function isSlackFileUrl(raw: string): boolean {
  if (typeof raw !== 'string' || !raw.startsWith('https://files.slack.com/')) return false;
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && u.hostname === 'files.slack.com' && !u.username && !u.password && (u.port === '' || u.port === '443');
  } catch {
    return false;
  }
}

export type DownloadResult =
  | { ok: true; bytes: Buffer; content_type: string; status: number }
  | { ok: false; outcome: 'file_not_found' | 'not_authorised' | 'error'; status: number; message: string };

/**
 * GET the file with the bot token. Redirects are **not** followed: an
 * unauthorised request to files.slack.com is redirected to a sign-in page that
 * answers 200 with HTML, and following it would hand the caller a login page
 * as the file's text.
 */
export async function download(url: string): Promise<DownloadResult> {
  const t = token();
  if (!t) return { ok: false, outcome: 'error', status: 0, message: `${SLACK_TOKEN_VAR} is not set on this server, so no Slack file can be downloaded.` };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const target = FILES_ORIGIN ? `${FILES_ORIGIN}${new URL(url).pathname}${new URL(url).search}` : url;
    const res = await fetch(target, { headers: { Authorization: `Bearer ${t}` }, redirect: 'manual', signal: controller.signal });
    const type = res.headers.get('content-type') ?? '';
    if (res.status === 404 || res.status === 410) return { ok: false, outcome: 'file_not_found', status: res.status, message: `Slack answered ${res.status}: no file at that address, or it has been deleted.` };
    if (res.status === 401 || res.status === 403) return { ok: false, outcome: 'not_authorised', status: res.status, message: `Slack answered ${res.status}: the Bays bot cannot read this file (it needs files:read, and to be in the channel the file was shared in).` };
    if (res.status >= 300 && res.status < 400) {
      const to = res.headers.get('location') ?? '';
      return { ok: false, outcome: 'not_authorised', status: res.status, message: `Slack redirected (${res.status}) to ${to.split('?')[0] || 'another page'} instead of serving the file — the Bays bot is not allowed to read it.` };
    }
    if (!res.ok) return { ok: false, outcome: 'error', status: res.status, message: `Slack answered ${res.status}: ${(await res.text()).slice(0, 300)}` };
    const len = Number(res.headers.get('content-length') ?? 0);
    if (len > MAX_FILE_BYTES) return { ok: false, outcome: 'error', status: res.status, message: `The file is ${len} bytes, over the ${MAX_FILE_BYTES}-byte limit.` };
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length > MAX_FILE_BYTES) return { ok: false, outcome: 'error', status: res.status, message: `The file is ${bytes.length} bytes, over the ${MAX_FILE_BYTES}-byte limit.` };
    // A sign-in page served as 200 is Slack refusing, not a file.
    if (type.startsWith('text/html') && /<title>[^<]*(sign in|slack)[^<]*<\/title>/i.test(bytes.subarray(0, 4096).toString('utf8'))) {
      return { ok: false, outcome: 'not_authorised', status: res.status, message: 'Slack served its sign-in page instead of the file — the Bays bot is not allowed to read it.' };
    }
    return { ok: true, bytes, content_type: type, status: res.status };
  } catch (e) {
    const timedOut = e instanceof Error && e.name === 'AbortError';
    return { ok: false, outcome: 'error', status: 0, message: timedOut ? `Slack did not answer within ${TIMEOUT_MS / 1000} seconds.` : `Could not reach Slack: ${e instanceof Error ? e.message : String(e)}` };
  } finally {
    clearTimeout(timer);
  }
}

/** A DM from Bays to one person, by Slack user id. chat.postMessage opens the IM itself. */
export async function dm(userId: string, text: string): Promise<{ ok: boolean; detail: string; ts?: string }> {
  const t = token();
  if (!t) return { ok: false, detail: `${SLACK_TOKEN_VAR} is not set on this server, so the DM was not sent.` };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${API}/chat.postMessage`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ channel: userId, text }),
      signal: controller.signal,
    });
    const body = (await res.json().catch(() => null)) as { ok?: boolean; error?: string; ts?: string } | null;
    if (!res.ok || !body?.ok) return { ok: false, detail: `Slack chat.postMessage answered ${res.status}${body?.error ? `: ${body.error}` : ''}.` };
    return { ok: true, detail: `sent to ${userId}`, ts: body.ts };
  } catch (e) {
    return { ok: false, detail: `Could not reach Slack: ${e instanceof Error ? e.message : String(e)}` };
  } finally {
    clearTimeout(timer);
  }
}
