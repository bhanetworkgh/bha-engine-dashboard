/**
 * The Stage 1 agreements (5 Nov 2026, Destiny), stored encrypted, one row per copy, read only through the
 * admin login or sent to Destiny or Jason by DM. AES-256-GCM under `AGREEMENTS_KEY` (32 bytes, base64), a key
 * that lives on the service and in Bitwarden: what the database holds is unreadable without it, so
 * query_postgres, a backup or an agent reading this table gets nothing. The key has no default and
 * nothing falls back to plain text: unset, a save or an open is refused by name. DocuSign stays the record of
 * what was signed.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { query } from './pg';

export class AgreementError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export const STATUSES = ['unsigned', 'signed', 'countersigned'] as const;
const MAX_BYTES = 15 * 1024 * 1024;
const TYPES = new Set(['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document']);

export interface AgreementRow {
  id: string;
  person_id: string;
  person_name: string;
  title: string;
  status: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  sha256: string;
  note: string | null;
  uploaded_by: string;
  uploaded_at: string;
}

const META = `id, person_id, person_name, title, status, filename, content_type, size_bytes, sha256, note, uploaded_by, uploaded_at`;

function key(): Buffer {
  const k = Buffer.from(process.env.AGREEMENTS_KEY ?? '', 'base64');
  if (k.length !== 32) throw new AgreementError(503, 'AGREEMENTS_KEY is not set on this server, so agreements cannot be read or saved.');
  return k;
}

export const keyConfigured = (): boolean => Buffer.from(process.env.AGREEMENTS_KEY ?? '', 'base64').length === 32;

export function seal(bytes: Buffer, k: Buffer): { iv: Buffer; tag: Buffer; cipher: Buffer } {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', k, iv);
  const cipher = Buffer.concat([c.update(bytes), c.final()]);
  return { iv, tag: c.getAuthTag(), cipher };
}

export function unseal(s: { iv: Buffer; tag: Buffer; cipher: Buffer }, k: Buffer): Buffer {
  const d = createDecipheriv('aes-256-gcm', k, s.iv);
  d.setAuthTag(s.tag);
  return Buffer.concat([d.update(s.cipher), d.final()]);
}

export async function list(): Promise<{ agreements: AgreementRow[]; key_configured: boolean }> {
  const r = await query<AgreementRow>(`SELECT ${META} FROM engine_agreements ORDER BY uploaded_at DESC`);
  return { agreements: r.rows, key_configured: keyConfigured() };
}

export async function save(i: { person_id: string; person_name: string; status: string; filename: string; content_type: string; bytes: Buffer; note?: string | null; by: string }): Promise<AgreementRow> {
  if (!i.person_id || !i.person_name) throw new AgreementError(422, 'Say whose agreement this is.');
  if (!(STATUSES as readonly string[]).includes(i.status)) throw new AgreementError(422, `Status must be one of: ${STATUSES.join(', ')}.`);
  if (!TYPES.has(i.content_type)) throw new AgreementError(422, 'An agreement is a PDF or a Word file.');
  if (!i.bytes.length) throw new AgreementError(422, 'The file is empty.');
  if (i.bytes.length > MAX_BYTES) throw new AgreementError(413, 'An agreement can be 15 MB at most.');
  const k = key();
  const sha256 = createHash('sha256').update(i.bytes).digest('hex');
  const s = seal(i.bytes, k);
  const id = `AG-${i.person_id.toUpperCase().replace(/[^A-Z0-9]+/g, '-')}-${sha256.slice(0, 8).toUpperCase()}`;
  const r = await query<AgreementRow>(
    `INSERT INTO engine_agreements (id, person_id, person_name, title, status, filename, content_type, size_bytes, sha256, iv, tag, cipher, note, uploaded_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT (sha256) DO NOTHING RETURNING ${META}`,
    [id, i.person_id, i.person_name, `Stage 1 agreement: ${i.person_name}`, i.status, i.filename, i.content_type, i.bytes.length, sha256, s.iv, s.tag, s.cipher, i.note ?? null, i.by],
  );
  if (!r.rows[0]) throw new AgreementError(409, 'This exact file is already held.');
  return r.rows[0];
}

export async function open(id: string): Promise<{ row: AgreementRow; bytes: Buffer }> {
  const k = key();
  const r = await query<AgreementRow & { iv: Buffer; tag: Buffer; cipher: Buffer }>(`SELECT ${META}, iv, tag, cipher FROM engine_agreements WHERE id = $1`, [id]);
  const row = r.rows[0];
  if (!row) throw new AgreementError(404, 'No such agreement.');
  return { row, bytes: unseal(row, k) };
}

/** Pure: the copy to send for a person: the furthest along, then the newest. */
export function bestFor(rows: AgreementRow[], person: string): AgreementRow | null {
  const want = person.trim().toLowerCase();
  const hit = rows.filter((r) => r.person_id.toLowerCase() === want || r.person_name.toLowerCase().split(/\s+/).includes(want) || r.person_name.toLowerCase() === want);
  const rank = (s: string) => (STATUSES as readonly string[]).indexOf(s);
  return hit.sort((a, b) => rank(b.status) - rank(a.status) || String(b.uploaded_at).localeCompare(String(a.uploaded_at)))[0] ?? null;
}

/** One-time carry of files sealed elsewhere under the same key. Rows already held are left alone. */
export async function importSeed(): Promise<number> {
  const path = join(process.cwd(), 'server', 'data', 'agreements-seed.json');
  if (!existsSync(path)) return 0;
  const rows = JSON.parse(readFileSync(path, 'utf8')) as (Omit<AgreementRow, 'uploaded_at'> & { iv: string; tag: string; cipher: string })[];
  let n = 0;
  for (const a of rows) {
    const r = await query(
      `INSERT INTO engine_agreements (id, person_id, person_name, title, status, filename, content_type, size_bytes, sha256, iv, tag, cipher, note, uploaded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT DO NOTHING`,
      [a.id, a.person_id, a.person_name, a.title, a.status, a.filename, a.content_type, a.size_bytes, a.sha256, Buffer.from(a.iv, 'base64'), Buffer.from(a.tag, 'base64'), Buffer.from(a.cipher, 'base64'), a.note, a.uploaded_by],
    );
    n += r.rowCount ?? 0;
  }
  return n;
}
