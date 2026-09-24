/**
 * Google Drive and Docs, for the MCP tools that write documents
 * (2026-09-24, Destiny): `share_doc`, `grant_drive_access`, `create_doc` and
 * the build-pattern Doc a `create_record {kind: "patterns"}` makes.
 *
 * **No Google credential existed on this server before this file.** n8n's
 * "Admin Google Docs" is an OAuth2 credential n8n holds and this server cannot
 * read, so one has to be set here. Two shapes are accepted and the boot line
 * names which is in use; nothing is defaulted:
 *
 *   **OAuth refresh token** — `GOOGLE_OAUTH_CLIENT_ID`,
 *   `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REFRESH_TOKEN`. Acts as the
 *   Google user who granted it, like n8n's credential does, so a Doc lands in
 *   that user's Drive folder and counts against their storage.
 *
 *   **Service account** — `GOOGLE_SERVICE_ACCOUNT_JSON`, the key file whole.
 *   Signed here with Node's own crypto (RS256), so no dependency is added. A
 *   service account has no Drive storage of its own: it can only create a file
 *   inside a shared drive, or a folder shared with it as an editor, and Google
 *   refuses the create with `storageQuotaExceeded` otherwise — that refusal is
 *   passed through verbatim, never retried as something else.
 *
 * Every failure carries the step and Google's own answer, so a refusal names
 * whether it was the token exchange, the create or the write.
 */
import { createSign } from 'node:crypto';

const SCOPES = ['https://www.googleapis.com/auth/drive', 'https://www.googleapis.com/auth/documents'];
const TIMEOUT_MS = 20_000;
/**
 * `GOOGLE_API_URL` is optional and only for a local stand-in (the tests): set,
 * the token exchange, Drive and Docs are all served under it. Like
 * `AIRTABLE_API_URL` and `BHARAG_API_URL`, unset is the real thing.
 */
const OVERRIDE = process.env.GOOGLE_API_URL?.trim().replace(/\/+$/, '') || null;
const TOKEN_URL = OVERRIDE ? `${OVERRIDE}/token` : 'https://oauth2.googleapis.com/token';
const DRIVE = OVERRIDE ? `${OVERRIDE}/drive/v3` : 'https://www.googleapis.com/drive/v3';
const DOCS = OVERRIDE ? `${OVERRIDE}/v1` : 'https://docs.googleapis.com/v1';

export const GOOGLE_OAUTH_VARS = ['GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET', 'GOOGLE_OAUTH_REFRESH_TOKEN'] as const;
export const GOOGLE_SA_VAR = 'GOOGLE_SERVICE_ACCOUNT_JSON';

type Mode = 'oauth' | 'service_account' | null;

function env(name: string): string | null {
  return process.env[name]?.trim() || null;
}

export function googleMode(): Mode {
  if (GOOGLE_OAUTH_VARS.every((v) => env(v))) return 'oauth';
  if (env(GOOGLE_SA_VAR)) return 'service_account';
  return null;
}

export function googleConfigured(): boolean {
  return googleMode() !== null;
}

/** What to set, in one sentence, for a not-configured answer. */
export function notConfiguredMessage(): string {
  const partial = GOOGLE_OAUTH_VARS.filter((v) => env(v));
  const tail = partial.length && partial.length < 3 ? ` (${partial.join(', ')} is set, but not all three)` : '';
  return `No Google credential is set on this server${tail}: set ${GOOGLE_OAUTH_VARS.join(', ')} (an OAuth refresh token), or ${GOOGLE_SA_VAR} (a service account key).`;
}

export class GoogleError extends Error {
  constructor(
    message: string,
    public step: string,
    public status: number,
  ) {
    super(message);
    this.name = 'GoogleError';
  }
}

async function http(step: string, url: string, init: RequestInit): Promise<{ status: number; body: unknown; text: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    const text = await res.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    if (!res.ok) {
      const g = body as { error?: { message?: string; errors?: { reason?: string }[] } | string; error_description?: string } | null;
      const msg =
        typeof g?.error === 'object' ? `${g.error.message ?? ''}${g.error.errors?.[0]?.reason ? ` (${g.error.errors[0].reason})` : ''}` : [g?.error, g?.error_description].filter(Boolean).join(': ');
      throw new GoogleError(`Google answered ${res.status} at ${step}: ${msg || text.slice(0, 300) || 'no body'}`, step, res.status);
    }
    return { status: res.status, body, text };
  } catch (e) {
    if (e instanceof GoogleError) throw e;
    const timedOut = e instanceof Error && e.name === 'AbortError';
    throw new GoogleError(timedOut ? `Google did not answer within ${TIMEOUT_MS / 1000} seconds at ${step}.` : `Could not reach Google at ${step}: ${e instanceof Error ? e.message : String(e)}`, step, 0);
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------- the token */

let cached: { token: string; until: number } | null = null;

function b64url(s: string | Buffer): string {
  return Buffer.from(s).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

async function accessToken(): Promise<string> {
  if (cached && cached.until > Date.now() + 60_000) return cached.token;
  const mode = googleMode();
  if (!mode) throw new GoogleError(notConfiguredMessage(), 'credential', 0);
  let form: URLSearchParams;
  if (mode === 'oauth') {
    form = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: env('GOOGLE_OAUTH_CLIENT_ID')!,
      client_secret: env('GOOGLE_OAUTH_CLIENT_SECRET')!,
      refresh_token: env('GOOGLE_OAUTH_REFRESH_TOKEN')!,
    });
  } else {
    let key: { client_email?: string; private_key?: string; token_uri?: string };
    try {
      key = JSON.parse(env(GOOGLE_SA_VAR)!);
    } catch {
      throw new GoogleError(`${GOOGLE_SA_VAR} is not valid JSON — it should be the service account key file, whole.`, 'credential', 0);
    }
    if (!key.client_email || !key.private_key) throw new GoogleError(`${GOOGLE_SA_VAR} has no client_email or private_key.`, 'credential', 0);
    const now = Math.floor(Date.now() / 1000);
    const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claim = b64url(JSON.stringify({ iss: key.client_email, scope: SCOPES.join(' '), aud: key.token_uri || TOKEN_URL, iat: now, exp: now + 3600 }));
    const sig = b64url(createSign('RSA-SHA256').update(`${head}.${claim}`).sign(key.private_key));
    form = new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${head}.${claim}.${sig}` });
  }
  const r = await http('token exchange', TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  const body = r.body as { access_token?: string; expires_in?: number };
  if (!body?.access_token) throw new GoogleError('Google answered the token exchange without an access_token.', 'token exchange', r.status);
  cached = { token: body.access_token, until: Date.now() + (body.expires_in ?? 3600) * 1000 };
  return cached.token;
}

async function authed(step: string, url: string, init: RequestInit = {}): Promise<{ status: number; body: unknown }> {
  const token = await accessToken();
  return http(step, url, { ...init, headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${token}`, Accept: 'application/json' } });
}

/* ------------------------------------------------------------- the calls */

export function docLink(id: string): string {
  return `https://docs.google.com/document/d/${id}/edit`;
}

export interface CreatedDoc {
  doc_id: string;
  link: string;
  /** False where the Doc exists but the text did not land; `error` says why. */
  content_written: boolean;
  error?: string;
}

/**
 * A Google Doc in a folder, then its text — the two calls n8n's
 * `LBP - Create Pattern Doc` and `LBP - Write Pattern Doc Content` make. The
 * first failing throws (nothing exists); the second failing returns the Doc
 * with `content_written: false`, because the Doc does exist and saying
 * otherwise would leave an empty file nobody knows about.
 */
export async function createDoc(folderId: string, title: string, content: string): Promise<CreatedDoc> {
  const created = await authed('create the Doc (drive files.create)', `${DRIVE}/files?supportsAllDrives=true&fields=id`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: title, mimeType: 'application/vnd.google-apps.document', parents: [folderId] }),
  });
  const id = (created.body as { id?: string })?.id;
  if (!id) throw new GoogleError('Drive answered the create without a file id.', 'create the Doc (drive files.create)', created.status);
  if (!content) return { doc_id: id, link: docLink(id), content_written: true };
  try {
    await authed('write the Doc text (docs batchUpdate)', `${DOCS}/documents/${encodeURIComponent(id)}:batchUpdate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requests: [{ insertText: { location: { index: 1 }, text: content } }] }),
    });
    return { doc_id: id, link: docLink(id), content_written: true };
  } catch (e) {
    return { doc_id: id, link: docLink(id), content_written: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export interface Permission {
  permission_id: string;
}

/** Anyone with the link can read. */
export async function shareAnyone(fileId: string): Promise<Permission> {
  const r = await authed('share (drive permissions.create, anyone reader)', `${DRIVE}/files/${encodeURIComponent(fileId)}/permissions?supportsAllDrives=true&fields=id`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'reader', type: 'anyone' }),
  });
  return { permission_id: String((r.body as { id?: string })?.id ?? '') };
}

/** One person, by email. The caller has already checked the domain. */
export async function grantUser(fileId: string, email: string, role: 'reader' | 'commenter' | 'writer'): Promise<Permission> {
  const r = await authed(`grant (drive permissions.create, user ${role})`, `${DRIVE}/files/${encodeURIComponent(fileId)}/permissions?supportsAllDrives=true&fields=id`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role, type: 'user', emailAddress: email }),
  });
  return { permission_id: String((r.body as { id?: string })?.id ?? '') };
}

/** The file's own link and type, so a share answers with the link Drive itself gives. */
export async function fileMeta(fileId: string): Promise<{ id: string; name: string; mimeType: string; webViewLink: string | null }> {
  const r = await authed('read the file (drive files.get)', `${DRIVE}/files/${encodeURIComponent(fileId)}?supportsAllDrives=true&fields=id,name,mimeType,webViewLink`);
  const b = r.body as { id: string; name: string; mimeType: string; webViewLink?: string };
  return { id: b.id, name: b.name, mimeType: b.mimeType, webViewLink: b.webViewLink ?? null };
}

/** For tests: forget the cached token. */
export function resetForTests(): void {
  cached = null;
}
