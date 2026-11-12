/**
 * The founder comp snapshot (12 Nov 2026, Destiny — Jason, DM D0AF0DG8ZPY 1794498144.803619: "a single, current
 * snapshot for all active founders/architects ... on a single Codex page you keep updated").
 *
 * One page, behind the admin login, because it holds every founder's day rate and equity and an agent token must
 * never read either. Two parts:
 * - Sections Destiny keeps (engine_comp_snapshot): the equity map, stages and pay, the waterfall, knowledge capture,
 *   production income and what is blocked, each written in plain text with "## " headings and "- " bullets. Every
 *   change keeps the text it replaced in engine_comp_snapshot_history, which the database refuses to edit or delete.
 * - Read live, never typed: the day rates by start date (engine_pay_rates, the pay card's own table) and the
 *   Stage 1 table (registry_stage1: status, signed, countersigned, knowledge capture).
 *
 * Written only by write_comp_snapshot (write connection, Destiny or Jason, refused on any agent token).
 */
import { query, withTransaction } from './pg';

export const ALLOWED = new Set(['U0AEW3TBYH1', 'U0A9V97949F']);
const ID_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;
export const MAX_BODY = 40_000;

export interface Section {
  section_id: string;
  position: number;
  title: string;
  body: string;
  updated_at: string;
  updated_by: string;
}

export interface Snapshot {
  sections: Section[];
  rates: { builder: string; builder_slack_id: string; day_rate_usd: string; effective_from: string; note: string | null }[];
  stage1: { id: string; name: string; lane: string | null; plan_status: string | null; agreement_sent: string | null; signed: string | null; countersigned: string | null; knowledge_capture: string | null; updated_at: string }[];
  updated_at: string | null;
}

export async function read(): Promise<Snapshot> {
  const [s, r, st] = await Promise.all([
    query<Section>(`SELECT section_id, position, title, body, updated_at::text AS updated_at, updated_by FROM engine_comp_snapshot ORDER BY position, section_id`),
    query<Snapshot['rates'][number]>(
      `SELECT builder, builder_slack_id, day_rate_usd::text AS day_rate_usd, effective_from::text AS effective_from, note
         FROM engine_pay_rates ORDER BY builder, effective_from`,
    ),
    query<Snapshot['stage1'][number]>(
      `SELECT id, name, lane, plan_status, agreement_sent, signed, countersigned, knowledge_capture, updated_at
         FROM registry_stage1 WHERE deleted_at IS NULL ORDER BY name`,
    ),
  ]);
  const newest = s.rows.reduce<string | null>((m, x) => (!m || x.updated_at > m ? x.updated_at : m), null);
  return { sections: s.rows, rates: r.rows, stage1: st.rows, updated_at: newest };
}

export type WriteResult =
  | { ok: true; written: boolean; section: Section; previous: Section | null }
  | { ok: false; reason: string; message: string };

/** Pure: is this a section write we accept? */
export function check(input: { section_id?: unknown; title?: unknown; body?: unknown; position?: unknown; by?: unknown }): string | null {
  if (typeof input.by !== 'string' || !ALLOWED.has(input.by)) return 'Only Destiny (U0AEW3TBYH1) or Jason (U0A9V97949F) can write the comp snapshot.';
  if (typeof input.section_id !== 'string' || !ID_RE.test(input.section_id)) return 'section_id: lower case letters, digits and hyphens, 2 to 41 characters.';
  if (input.title !== undefined && (typeof input.title !== 'string' || !input.title.trim() || input.title.length > 200)) return 'title: 1 to 200 characters.';
  if (typeof input.body !== 'string' || !input.body.trim()) return 'body is required.';
  if (input.body.length > MAX_BODY) return `body is at most ${MAX_BODY} characters.`;
  if (input.position !== undefined && (typeof input.position !== 'number' || !Number.isInteger(input.position) || input.position < 0 || input.position > 1000)) return 'position: a whole number, 0 to 1000.';
  return null;
}

export async function write(input: { section_id: string; title?: string; body: string; position?: number; by: string; reason?: string }, dryRun = false): Promise<WriteResult> {
  const problem = check(input);
  if (problem) return { ok: false, reason: 'invalid', message: problem };
  return withTransaction(async (db) => {
    const prev = (await db.query<Section>(
      `SELECT section_id, position, title, body, updated_at::text AS updated_at, updated_by FROM engine_comp_snapshot WHERE section_id = $1 FOR UPDATE`,
      [input.section_id],
    )).rows[0] ?? null;
    if (!prev && !input.title) return { ok: false, reason: 'title_required', message: `"${input.section_id}" is a new section: give it a title.` };
    const title = (input.title ?? prev?.title ?? '').trim();
    const position = input.position ?? prev?.position ?? 100;
    const body = input.body.replace(/\r\n/g, '\n').trim();
    if (prev && prev.body === body && prev.title === title && prev.position === position) {
      return { ok: true, written: false, section: prev, previous: prev };
    }
    if (dryRun) {
      return { ok: true, written: false, section: { section_id: input.section_id, position, title, body, updated_at: new Date().toISOString(), updated_by: input.by }, previous: prev };
    }
    if (prev) {
      await db.query(
        `INSERT INTO engine_comp_snapshot_history (section_id, title, body, position, written_at, written_by, replaced_by, reason)
         VALUES ($1, $2, $3, $4, $5::timestamptz, $6, $7, $8)`,
        [prev.section_id, prev.title, prev.body, prev.position, prev.updated_at, prev.updated_by, input.by, input.reason ?? null],
      );
    }
    const row = (await db.query<Section>(
      `INSERT INTO engine_comp_snapshot (section_id, position, title, body, updated_at, updated_by)
       VALUES ($1, $2, $3, $4, now(), $5)
       ON CONFLICT (section_id) DO UPDATE SET position = EXCLUDED.position, title = EXCLUDED.title, body = EXCLUDED.body,
         updated_at = now(), updated_by = EXCLUDED.updated_by
       RETURNING section_id, position, title, body, updated_at::text AS updated_at, updated_by`,
      [input.section_id, position, title, body, input.by],
    )).rows[0];
    return { ok: true, written: true, section: row, previous: prev };
  });
}
