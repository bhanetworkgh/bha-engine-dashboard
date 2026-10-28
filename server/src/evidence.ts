/**
 * The evidence store (28 Oct 2026, Destiny — Hardik's Stripe Honest Gate handoff, D0BKMFVU806
 * 1793075715.810679: "evidence lives on the dashboard, not in a Drive folder, so every system can
 * look it up by name").
 *
 * One record per document: its full text, the original file, what it proves, which gate or loop it
 * belongs to, who wrote it and when. Migration 103, `engine_evidence`.
 *
 * The rules:
 *   - A record is never edited or deleted (a trigger on the table refuses both). A correction is a new
 *     version under the same name, which names the version it supersedes; the old one stays readable,
 *     so whatever a decision rested on can still be read as it was.
 *   - Every record has a name (lower case and hyphens) and an id, EV-<ms>-<4>. Either finds it.
 *   - What it proves is written down by the person saving it, never inferred.
 *   - The same file twice is refused, naming the record that already holds it.
 *   - Only Destiny, Jason or someone with a Builder Profile may ask for a document to be saved.
 *   - It is not Codex: nothing here feeds review or pay.
 *
 * The charge gate's green acceptance pass names one of these records (bundle_ref = EV-…), and
 * chargeGate.recordGate refuses a pass whose record is not here.
 */
import { createHash } from 'node:crypto';
import { query, withTransaction } from './pg';
import { record } from './engineEvents';
import { changed } from './events';
import * as slack from './slack';
import { extractFileText } from './mcp/docTools';
import { fileIdFromUrl } from './mcp/audioTools';

export const DESTINY = 'U0AEW3TBYH1';
export const JASON = 'U0A9V97949F';

export const RULE = {
  name_max: 80,
  title_max: 200,
  proves_min: 10,
  proves_max: 2000,
  gate_max: 120,
  notes_max: 2000,
  text_max: 2_000_000,
  file_max_bytes: 15 * 1024 * 1024,
};

export const RULES = [
  'A record is never edited or deleted. A correction is a new version under the same name that names the version it supersedes; the old one stays readable.',
  'What a record proves is what the person who saved it wrote down. Never claim it proves more.',
  'Quote a record by its id (EV-…) or name. When a newer version exists, say which version a decision rested on.',
  'The evidence store is not Codex: nothing in it feeds review or pay.',
];

const PUBLIC = (process.env.PUBLIC_DASHBOARD_URL?.trim() || 'https://dashboard.bhanetwork.org').replace(/\/$/, '');
export const pageUrl = (id: string): string => `${PUBLIC}/evidence?doc=${encodeURIComponent(id)}`;
export const fileUrl = (id: string): string => `${PUBLIC}/api/evidence/${encodeURIComponent(id)}/file`;

export class EvidenceError extends Error {
  constructor(public reason: string, message: string, public extra: Record<string, unknown> = {}) {
    super(message);
  }
}

export interface Evidence {
  evidence_id: string;
  name: string;
  version: number;
  title: string;
  proves: string;
  gate: string | null;
  loop_id: string | null;
  author_id: string;
  author_name: string | null;
  written_at: string | null;
  saved_by: string;
  saved_by_name: string | null;
  saved_at: string;
  via: string;
  source_kind: 'slack_file' | 'text';
  source_ref: string | null;
  file_name: string;
  content_type: string;
  file_size: number;
  file_sha256: string;
  text_chars: number;
  text_sha256: string;
  extract: Record<string, unknown>;
  supersedes: string | null;
  superseded_by: string | null;
  notes: string | null;
  test: boolean;
}

export type EvidenceWithText = Evidence & { text: string };

const COLS = `evidence_id, name, version, title, proves, gate, loop_id, author_id, author_name, written_at, saved_by, saved_by_name,
  saved_at, via, source_kind, source_ref, file_name, content_type, file_size, file_sha256, text_chars, text_sha256, extract,
  supersedes, notes, test`;

const iso = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : typeof v === 'string' ? v : null);

function mapRow(r: Record<string, unknown>, supersededBy: Map<string, string>): Evidence {
  return {
    evidence_id: r.evidence_id as string,
    name: r.name as string,
    version: Number(r.version),
    title: r.title as string,
    proves: r.proves as string,
    gate: (r.gate as string) ?? null,
    loop_id: (r.loop_id as string) ?? null,
    author_id: r.author_id as string,
    author_name: (r.author_name as string) ?? null,
    written_at: iso(r.written_at),
    saved_by: r.saved_by as string,
    saved_by_name: (r.saved_by_name as string) ?? null,
    saved_at: iso(r.saved_at) as string,
    via: r.via as string,
    source_kind: r.source_kind as Evidence['source_kind'],
    source_ref: (r.source_ref as string) ?? null,
    file_name: r.file_name as string,
    content_type: r.content_type as string,
    file_size: Number(r.file_size),
    file_sha256: r.file_sha256 as string,
    text_chars: Number(r.text_chars),
    text_sha256: r.text_sha256 as string,
    extract: (r.extract as Record<string, unknown>) ?? {},
    supersedes: (r.supersedes as string) ?? null,
    superseded_by: supersededBy.get(r.evidence_id as string) ?? null,
    notes: (r.notes as string) ?? null,
    test: r.test === true,
  };
}

async function supersededMap(ids: string[]): Promise<Map<string, string>> {
  const m = new Map<string, string>();
  if (!ids.length) return m;
  const r = await query<{ supersedes: string; evidence_id: string }>(`SELECT supersedes, evidence_id FROM engine_evidence WHERE supersedes = ANY($1::text[])`, [ids]);
  for (const row of r.rows) m.set(row.supersedes, row.evidence_id);
  return m;
}

export const sha = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');

const clean = (v: unknown, max: number): string => (typeof v === 'string' ? v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, max) : '');
const slackId = (v: unknown): string => clean(v, 30).replace(/^<@?([A-Z0-9]+)(\|[^>]*)?>$/, '$1');

/** A name is lower case, digits and hyphens: "stripe-acceptance-bundle". */
export function normaliseName(raw: string): string {
  return raw
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\x00-\x7f]/g, '')
    .replace(/\.[a-z0-9]{1,5}$/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, RULE.name_max);
}

function newId(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 4; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return `EV-${Date.now()}-${s}`;
}

export const EV_ID = /^EV-\d{10,}-[A-Z0-9]{4}$/;

async function profileName(id: string): Promise<string | null> {
  if (id === DESTINY) return 'Destiny Arupi';
  if (id === JASON) return 'Jason Bays';
  const r = await query<{ name: string | null }>(`SELECT fields->>'name' AS name FROM engine_builder_profiles WHERE natural_id = $1 LIMIT 1`, [id]).catch(() => ({ rows: [] as Array<{ name: string | null }> }));
  return r.rows[0]?.name ?? null;
}

export interface SaveInput {
  name?: string | null;
  title?: string | null;
  proves: string;
  gate?: string | null;
  loop_id?: string | null;
  author_id: string;
  written_at?: string | null;
  requester_user_id: string;
  supersedes?: string | null;
  notes?: string | null;
  /** One of: a Slack file (url or id), or the text itself. */
  slack_file_url?: string | null;
  slack_file_id?: string | null;
  text?: string | null;
  file_name?: string | null;
  test?: boolean;
}

export interface FetchedFile {
  bytes: Buffer;
  content_type: string;
  file_name: string;
  source_kind: Evidence['source_kind'];
  source_ref: string | null;
}

/** The file as Slack holds it. Injectable so the tests need no Slack. */
export type SlackFetch = (args: { url: string | null; file_id: string | null }) => Promise<FetchedFile>;

export const fetchSlackFile: SlackFetch = async ({ url, file_id }) => {
  if (!slack.slackConfigured()) throw new EvidenceError('not_configured', `${slack.SLACK_TOKEN_VAR} is not set on this server, so no Slack file can be read.`);
  let id = file_id || (url ? fileIdFromUrl(url) : null);
  let name = '';
  let mime = '';
  let download = url || '';
  let permalink: string | null = null;
  if (id) {
    const r = await slack.botCall('files.info', { file: id }, 'form');
    if (r.ok && r.file && typeof r.file === 'object') {
      const f = r.file as Record<string, unknown>;
      name = typeof f.name === 'string' ? f.name : typeof f.title === 'string' ? f.title : '';
      mime = typeof f.mimetype === 'string' ? f.mimetype : '';
      permalink = typeof f.permalink === 'string' ? f.permalink : null;
      if (!download) download = (typeof f.url_private_download === 'string' ? f.url_private_download : '') || (typeof f.url_private === 'string' ? f.url_private : '');
    } else if (!url) {
      const e = String(r.error ?? 'unknown');
      throw new EvidenceError(e === 'file_not_found' || e === 'file_deleted' ? 'file_not_found' : 'slack_error', `Slack would not describe file ${id}: ${e}.`);
    }
  }
  if (!download || !slack.isSlackFileUrl(download)) throw new EvidenceError('not_a_slack_file_url', 'Only https://files.slack.com/ files are read. Pass the file’s url_private or its file id (F…).');
  const d = await slack.download(download);
  if (!d.ok) throw new EvidenceError(d.outcome, `The file could not be downloaded from Slack: ${d.message}`);
  if (!name) name = decodeURIComponent(download.split('?')[0].split('/').pop() || 'file');
  id = id || fileIdFromUrl(download);
  return { bytes: d.bytes, content_type: mime || d.content_type || 'application/octet-stream', file_name: name, source_kind: 'slack_file', source_ref: permalink || (id ? `slack:${id}` : download.split('?')[0]) };
};

export interface SaveResult {
  ok: true;
  written: boolean;
  record: Evidence;
  text_preview: string;
  url: string;
  file_url: string;
  message: string;
}

/** Saves one document. Refused, with nothing written, when a rule says no. */
export async function save(input: SaveInput, opts: { via: string; dry_run?: boolean; fetch?: SlackFetch } = { via: 'unknown' }): Promise<SaveResult> {
  const requester = slackId(input.requester_user_id);
  if (!/^[UW][A-Z0-9]{6,}$/.test(requester)) throw new EvidenceError('requester_required', 'requester_user_id must be the Slack id of the person asking for the document to be saved.');
  const requesterName = await profileName(requester);
  if (requester !== DESTINY && requester !== JASON && !requesterName) {
    throw new EvidenceError('not_permitted', `Only Destiny, Jason or someone with a Builder Profile may save evidence; ${requester} has none.`);
  }
  const author = slackId(input.author_id);
  if (!/^[UW][A-Z0-9]{6,}$/.test(author)) throw new EvidenceError('author_required', 'author_id must be the Slack id of the person who wrote the document (not who is saving it, if that is someone else).');
  const proves = clean(input.proves, RULE.proves_max + 1);
  if (proves.length < RULE.proves_min) throw new EvidenceError('proves_required', `Say what the document proves, in at least ${RULE.proves_min} characters. Nothing is inferred for it.`);
  if (proves.length > RULE.proves_max) throw new EvidenceError('proves_too_long', `What it proves is ${RULE.proves_max} characters at most.`);
  const gate = clean(input.gate, RULE.gate_max) || null;
  const loop_id = clean(input.loop_id, 60) || null;
  if (loop_id && !/^LOOP-\d{10,}-[A-Z0-9]{4}$/.test(loop_id)) throw new EvidenceError('bad_loop_id', 'loop_id is LOOP-<ms>-<4>.');
  const notes = clean(input.notes, RULE.notes_max) || null;
  let written_at: string | null = null;
  if (input.written_at) {
    const t = Date.parse(String(input.written_at));
    if (!Number.isFinite(t)) throw new EvidenceError('bad_written_at', 'written_at is a date (YYYY-MM-DD) or an ISO time.');
    written_at = new Date(t).toISOString();
  }

  // The document itself: a Slack file, or text handed over whole.
  const slackUrl = clean(input.slack_file_url, 1000) || null;
  const fileId = clean(input.slack_file_id, 30) || null;
  const rawText = typeof input.text === 'string' ? input.text : '';
  const sources = [slackUrl || fileId ? 'file' : null, rawText ? 'text' : null].filter(Boolean);
  if (sources.length !== 1) throw new EvidenceError('one_source', 'Give exactly one source: a Slack file (slack_file_url or slack_file_id), or the text.');
  if (fileId && !/^F[A-Z0-9]{6,}$/.test(fileId)) throw new EvidenceError('not_a_slack_file_id', 'slack_file_id is a Slack file id, e.g. F0ABC123DEF.');
  let f: FetchedFile;
  if (rawText) {
    const fn = clean(input.file_name, 200) || `${normaliseName(clean(input.name, RULE.name_max) || 'evidence') || 'evidence'}.md`;
    f = { bytes: Buffer.from(rawText, 'utf8'), content_type: /\.md$/i.test(fn) ? 'text/markdown' : 'text/plain', file_name: fn, source_kind: 'text', source_ref: null };
  } else {
    f = await (opts.fetch ?? fetchSlackFile)({ url: slackUrl, file_id: fileId });
  }
  if (f.bytes.length > RULE.file_max_bytes) throw new EvidenceError('file_too_large', `The file is ${f.bytes.length} bytes; ${RULE.file_max_bytes} at most.`);
  const ft = extractFileText(f.bytes, f.content_type);
  if (!ft.ok) throw new EvidenceError(String(ft.reason ?? 'unreadable'), String(ft.message ?? 'The file could not be read as text.'), { type: ft.type ?? null });
  const text = ft.text.replace(/\r\n/g, '\n');
  if (!text.trim()) throw new EvidenceError('no_text', 'The document has no text.');
  if (text.length > RULE.text_max) throw new EvidenceError('text_too_long', `The document's text is ${text.length} characters; ${RULE.text_max} at most.`);
  // A Markdown or text file read as text keeps its own type, not whatever Slack guessed.
  if (/\.(md|markdown)$/i.test(f.file_name) && !/pdf|zip|officedocument/.test(f.content_type)) f.content_type = 'text/markdown';

  const name = normaliseName(clean(input.name, RULE.name_max * 2) || f.file_name);
  if (!name || name.length < 3) throw new EvidenceError('name_required', 'Give the record a name of at least 3 letters (lower case and hyphens), e.g. stripe-acceptance-bundle.');
  const title = clean(input.title, RULE.title_max) || f.file_name;
  const file_sha256 = sha(f.bytes);
  const test = input.test === true;

  // The same file twice is one record.
  const dup = await query<{ evidence_id: string; name: string; version: number }>(`SELECT evidence_id, name, version FROM engine_evidence WHERE file_sha256 = $1 AND test = $2 LIMIT 1`, [file_sha256, test]);
  if (dup.rows[0]) {
    const d = dup.rows[0];
    throw new EvidenceError('already_saved', `This exact file is already saved as ${d.evidence_id} (${d.name}, version ${d.version}). Nothing new was saved.`, { evidence_id: d.evidence_id, url: pageUrl(d.evidence_id) });
  }
  // A name is one document; a new version names the one it replaces.
  const latest = await query<{ evidence_id: string; version: number }>(`SELECT evidence_id, version FROM engine_evidence WHERE name = $1 AND test = $2 ORDER BY version DESC LIMIT 1`, [name, test]);
  const supersedes = clean(input.supersedes, 40) || null;
  let version = 1;
  if (latest.rows[0]) {
    const l = latest.rows[0];
    if (!supersedes) throw new EvidenceError('name_taken', `"${name}" is already ${l.evidence_id} (version ${l.version}). To save a corrected version, pass supersedes: "${l.evidence_id}". To save a different document, give it another name.`, { evidence_id: l.evidence_id });
    if (supersedes !== l.evidence_id) throw new EvidenceError('supersedes_not_latest', `The newest version of "${name}" is ${l.evidence_id}; a new version supersedes that one, not ${supersedes}.`, { evidence_id: l.evidence_id });
    version = Number(l.version) + 1;
  } else if (supersedes) {
    throw new EvidenceError('supersedes_unknown', `No record named "${name}" exists for ${supersedes} to be replaced in. A new version keeps the same name.`);
  }

  const row = {
    evidence_id: newId(),
    name,
    version,
    title,
    proves,
    gate,
    loop_id,
    author_id: author,
    author_name: await profileName(author),
    written_at,
    saved_by: requester,
    saved_by_name: requesterName,
    via: opts.via,
    source_kind: f.source_kind,
    source_ref: f.source_ref,
    file_name: f.file_name,
    content_type: f.content_type,
    file_size: f.bytes.length,
    file_sha256,
    text_chars: text.length,
    text_sha256: sha(text),
    extract: ft.extra,
    supersedes,
    notes,
    test,
  };
  const preview = text.slice(0, 600);
  if (opts.dry_run) {
    const rec: Evidence = { ...row, saved_at: new Date().toISOString(), superseded_by: null };
    return { ok: true, written: false, record: rec, text_preview: preview, url: pageUrl(row.evidence_id), file_url: fileUrl(row.evidence_id), message: `Dry run: "${title}" would be saved as ${name} version ${version} (${text.length} characters of text, ${f.bytes.length} bytes of file). Nothing was written.` };
  }
  const saved_at = await withTransaction(async (db) => {
    const ins = await db.query(
      `INSERT INTO engine_evidence (evidence_id, name, version, title, proves, gate, loop_id, author_id, author_name, written_at, saved_by, saved_by_name,
         via, source_kind, source_ref, file_name, content_type, file_size, file_sha256, file_bytes, text, text_chars, text_sha256, extract, supersedes, notes, test)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24::jsonb,$25,$26,$27) RETURNING saved_at`,
      [row.evidence_id, row.name, row.version, row.title, row.proves, row.gate, row.loop_id, row.author_id, row.author_name, row.written_at, row.saved_by, row.saved_by_name,
        row.via, row.source_kind, row.source_ref, row.file_name, row.content_type, row.file_size, row.file_sha256, f.bytes, text, row.text_chars, row.text_sha256, JSON.stringify(row.extract), row.supersedes, row.notes, row.test],
    );
    await record(
      {
        event_type: 'evidence_saved',
        subject_id: row.evidence_id,
        lane: null,
        actor: row.saved_by,
        source_ref: row.source_ref,
        detail: { evidence_id: row.evidence_id, name: row.name, version: row.version, title: row.title, gate: row.gate, loop_id: row.loop_id, author_id: row.author_id, file_sha256: row.file_sha256, supersedes: row.supersedes, test: row.test },
        dedupe_key: `evidence:${row.evidence_id}`,
      },
      db,
    );
    return iso((ins.rows[0] as { saved_at: Date }).saved_at) as string;
  });
  changed('evidence', row.evidence_id);
  const rec: Evidence = { ...row, saved_at, superseded_by: null };
  return {
    ok: true,
    written: true,
    record: rec,
    text_preview: preview,
    url: pageUrl(row.evidence_id),
    file_url: fileUrl(row.evidence_id),
    message: `Saved "${title}" as ${row.evidence_id} (${name}, version ${version}${supersedes ? `, replacing ${supersedes}` : ''}).`,
  };
}

/** One record by id or name (the newest version of a name), with its text. Test records only when asked. */
export async function get(idOrName: string, opts: { test?: boolean } = {}): Promise<EvidenceWithText | null> {
  const key = idOrName.trim();
  if (!key) return null;
  const r = EV_ID.test(key)
    ? await query(`SELECT ${COLS}, text FROM engine_evidence WHERE evidence_id = $1`, [key])
    : await query(`SELECT ${COLS}, text FROM engine_evidence WHERE name = $1 AND test = $2 ORDER BY version DESC LIMIT 1`, [normaliseName(key), opts.test === true]);
  const row = r.rows[0] as Record<string, unknown> | undefined;
  if (!row) return null;
  const sup = await supersededMap([row.evidence_id as string]);
  return { ...mapRow(row, sup), text: row.text as string };
}

/** Whether a green pass may rest on this id: held, not a test. Newer versions are named, not refused. */
export async function forGate(id: string): Promise<{ ok: true; record: Evidence } | { ok: false; reason: string; message: string }> {
  if (!EV_ID.test(id)) return { ok: false, reason: 'bundle_not_evidence', message: `bundle_ref must be an evidence store id (EV-…), not "${id.slice(0, 80)}". Save the acceptance bundle into the evidence store first.` };
  const rec = await get(id);
  if (!rec) return { ok: false, reason: 'bundle_not_found', message: `No evidence record ${id} is held.` };
  if (rec.test) return { ok: false, reason: 'bundle_is_test', message: `${id} is a test record; a real pass cannot rest on it.` };
  return { ok: true, record: rec };
}

export interface ListFilter {
  search?: string | null;
  gate?: string | null;
  loop_id?: string | null;
  name?: string | null;
  include_test?: boolean;
  all_versions?: boolean;
  limit?: number;
}

/** Newest first, without the text. Only the newest version of each name, unless all_versions. */
export async function list(f: ListFilter = {}): Promise<{ records: Evidence[]; total: number }> {
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, v: unknown) => {
    params.push(v);
    where.push(sql.replace('?', `$${params.length}`));
  };
  if (!f.include_test) where.push('test = false');
  if (f.gate) add('lower(gate) = lower(?)', f.gate);
  if (f.loop_id) add('loop_id = ?', f.loop_id);
  if (f.name) add('name = ?', normaliseName(f.name));
  if (f.search) {
    const s = f.search.toLowerCase().trim();
    params.push(s);
    const n = params.length;
    where.push(`(strpos(lower(title), $${n}) > 0 OR strpos(name, $${n}) > 0 OR strpos(lower(proves), $${n}) > 0 OR strpos(lower(coalesce(gate, '')), $${n}) > 0 OR strpos(lower(text), $${n}) > 0 OR evidence_id = upper($${n}))`);
  }
  if (!f.all_versions) where.push(`NOT EXISTS (SELECT 1 FROM engine_evidence n WHERE n.supersedes = engine_evidence.evidence_id)`);
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const limit = Math.min(Math.max(Number(f.limit) || 100, 1), 500);
  const r = await query(`SELECT ${COLS}, count(*) OVER () AS total FROM engine_evidence ${w} ORDER BY saved_at DESC LIMIT ${limit}`, params);
  const rows = r.rows as Array<Record<string, unknown>>;
  const sup = await supersededMap(rows.map((x) => x.evidence_id as string));
  return { records: rows.map((x) => mapRow(x, sup)), total: rows.length ? Number(rows[0].total) : 0 };
}

/** Every version of one name, oldest first. */
export async function versions(name: string, test = false): Promise<Evidence[]> {
  const r = await query(`SELECT ${COLS} FROM engine_evidence WHERE name = $1 AND test = $2 ORDER BY version`, [normaliseName(name), test]);
  const rows = r.rows as Array<Record<string, unknown>>;
  const sup = await supersededMap(rows.map((x) => x.evidence_id as string));
  return rows.map((x) => mapRow(x, sup));
}

/** The original file, for the download button. */
export async function file(id: string): Promise<{ bytes: Buffer; file_name: string; content_type: string } | null> {
  if (!EV_ID.test(id)) return null;
  const r = await query<{ file_bytes: Buffer; file_name: string; content_type: string }>(`SELECT file_bytes, file_name, content_type FROM engine_evidence WHERE evidence_id = $1`, [id]);
  const row = r.rows[0];
  return row ? { bytes: row.file_bytes, file_name: row.file_name, content_type: row.content_type } : null;
}

/** The page's read: every current record, and the rules. */
export async function read(opts: { include_test?: boolean } = {}): Promise<{ records: Evidence[]; total: number; rules: string[] }> {
  const r = await list({ include_test: opts.include_test, limit: 500 });
  return { ...r, rules: RULES };
}
