/**
 * SOPs, read from BHARAG (2026-10-13, Destiny — the SOPs tab on Codex).
 *
 * An SOP is a document Bays (or a person through Bays) wrote into BHARAG's
 * codex workspace with `Ingest_To_BHARAG`, titled "SOP -- …". BHARAG is where
 * the twins read them, so BHARAG is the only source here: nothing is copied
 * into Postgres, and an SOP removed from BHARAG leaves this list on the next
 * read. Read only; this file never writes to BHARAG.
 *
 * **Every page of the workspace is read**, because BHARAG lists documents
 * newest first with no title filter, and the codex workspace also holds every
 * Codex log. A read that stopped early would hide the oldest SOPs and look
 * complete, so a read that hit the page cap says `complete: false`.
 *
 * Held for five minutes so the tab does not walk the workspace on every load;
 * `fresh` reads it again. Two reads at once share one walk.
 */
import * as bharag from './bharag';

const WORKSPACE = 'codex' as const;
const PAGE = 100; // BHARAG's own maximum for GET /documents
const MAX_PAGES = 60; // 6,000 documents; past that the answer says it is incomplete
const HOLD_MS = 5 * 60_000;

/**
 * Which key opens the workspace Bays writes SOPs into (2026-10-13). The first
 * live read with BHARAG_CODEX_KEY reached a workspace whose newest documents
 * were commercial cards and none of that day's SOPs, while Bays reads and
 * writes SOPs with n8n's "BHARAG - Codex" credential. So the SOP read has its
 * own variable, holding that credential's key, and falls back to the codex key
 * only when it is unset, saying so on every answer.
 */
export const SOPS_KEY_VAR = 'BHARAG_SOPS_KEY';
function keyVar(): string {
  return process.env[SOPS_KEY_VAR]?.trim() ? SOPS_KEY_VAR : bharag.INGEST_KEY_VARS[WORKSPACE];
}

/** A title that starts with "SOP" is an SOP. Exported for the test. */
export function isSopTitle(title: unknown): boolean {
  return typeof title === 'string' && /^\s*SOP\b/i.test(title);
}

function text(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/** Where the SOP came from, read from what the ingest stored; null where it stored nothing. */
function sourceLink(d: bharag.WorkspaceDocument): string | null {
  const m = (d.metadata ?? {}) as Record<string, unknown>;
  return text(m.source_link) ?? text(m.sourceLink) ?? text(m.slack_link) ?? text(d.source_url) ?? null;
}

export interface SopRow {
  id: string;
  title: string;
  created_at: string | null;
  updated_at: string | null;
  status: string | null;
  source_link: string | null;
  requested_by: string | null;
  /** How many SOPs in BHARAG carry this exact title, case-blind. Above 1 means a copy. */
  same_title: number;
}

export interface SopsRead {
  ok: boolean;
  workspace: typeof WORKSPACE;
  read_at: string | null;
  /** Every document in the workspace was read. False when a page failed or the cap was reached. */
  complete: boolean;
  documents_scanned: number;
  pages_read: number;
  sops: SopRow[];
  note: string | null;
  error: string | null;
  /** The variable whose key opened the workspace. */
  key_variable: string;
  /** The five newest document titles read, whatever they are: which workspace the key opens, at a glance. */
  newest_titles: string[];
}

let held: { at: number; value: SopsRead } | null = null;
let inFlight: Promise<SopsRead> | null = null;

async function walk(): Promise<SopsRead> {
  const base = { ok: false, workspace: WORKSPACE, key_variable: keyVar(), read_at: null, complete: false, documents_scanned: 0, pages_read: 0, sops: [] as SopRow[], note: null, newest_titles: [] as string[] };
  if (!process.env[keyVar()]?.trim()) {
    return { ...base, error: `Neither ${SOPS_KEY_VAR} nor ${bharag.INGEST_KEY_VARS[WORKSPACE]} is set on this server, so the workspace SOPs live in cannot be read.` };
  }
  const found: bharag.WorkspaceDocument[] = [];
  let scanned = 0;
  let pages = 0;
  let more = true;
  let error: string | null = null;
  const newest: string[] = [];
  while (more && pages < MAX_PAGES) {
    try {
      const r = await bharag.listDocuments(WORKSPACE, PAGE, pages * PAGE, keyVar());
      pages += 1;
      scanned += r.documents.length;
      for (const d of r.documents) {
        if (newest.length < 5) newest.push(String(d.title ?? '(untitled)').slice(0, 120));
        if (isSopTitle(d.title)) found.push(d);
      }
      more = r.hasMore && r.documents.length > 0;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      break;
    }
  }
  const complete = !error && !more;
  // Nothing read at all is a failure, never an empty list.
  if (error && pages === 0) return { ...base, error: `BHARAG could not be read: ${error}` };
  const counts = new Map<string, number>();
  for (const d of found) {
    const k = String(d.title).trim().toLowerCase();
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const sops: SopRow[] = found
    .map((d) => {
      const m = (d.metadata ?? {}) as Record<string, unknown>;
      return {
        id: String(d.id),
        title: String(d.title).trim(),
        created_at: d.created_at ?? null,
        updated_at: d.updated_at ?? null,
        status: d.status ?? null,
        source_link: sourceLink(d),
        requested_by: text(m.requested_by) ?? text(m.requestedBy) ?? null,
        same_title: counts.get(String(d.title).trim().toLowerCase()) ?? 1,
      };
    })
    .sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')));
  const note = error
    ? `BHARAG stopped answering after ${pages} page${pages === 1 ? '' : 's'} (${scanned} documents): ${error}. Older SOPs may be missing from this list.`
    : more
      ? `Stopped at ${MAX_PAGES} pages (${scanned} documents). Older SOPs may be missing from this list.`
      : null;
  return { ok: true, workspace: WORKSPACE, key_variable: keyVar(), read_at: new Date().toISOString(), complete, documents_scanned: scanned, pages_read: pages, sops, note, error: null, newest_titles: newest };
}

/** Every SOP in BHARAG, newest first. */
export async function read(opts: { fresh?: boolean } = {}): Promise<SopsRead> {
  if (!opts.fresh && held && Date.now() - held.at < HOLD_MS) return held.value;
  if (!inFlight) {
    inFlight = walk()
      .then((v) => {
        // Only a complete read is held; a partial or failed one is asked again next time.
        held = v.ok && v.complete ? { at: Date.now(), value: v } : null;
        return v;
      })
      .finally(() => {
        inFlight = null;
      });
  }
  return inFlight;
}

export type SopDocResult =
  | { ok: true; sop: SopRow & { content: string | null; metadata: Record<string, unknown> | null } }
  | { ok: false; status: number; reason: string };

/** One SOP's full text. Refused for a document whose title is not an SOP: this is not a general BHARAG reader. */
export async function doc(id: string): Promise<SopDocResult> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return { ok: false, status: 400, reason: 'An SOP id is a BHARAG document id (a UUID).' };
  if (!process.env[keyVar()]?.trim()) return { ok: false, status: 503, reason: `Neither ${SOPS_KEY_VAR} nor ${bharag.INGEST_KEY_VARS[WORKSPACE]} is set on this server.` };
  let d: bharag.WorkspaceDocument | null;
  try {
    d = await bharag.getDocument(WORKSPACE, id, keyVar());
  } catch (e) {
    return { ok: false, status: 502, reason: `BHARAG could not be read: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!d) return { ok: false, status: 404, reason: 'BHARAG has no document with that id in the codex workspace. It may have been removed.' };
  if (!isSopTitle(d.title)) return { ok: false, status: 404, reason: 'That document is not an SOP.' };
  const m = (d.metadata ?? {}) as Record<string, unknown>;
  const title = String(d.title).trim();
  const listed = held?.value.sops.find((s) => s.id === d!.id);
  return {
    ok: true,
    sop: {
      id: String(d.id),
      title,
      created_at: d.created_at ?? null,
      updated_at: d.updated_at ?? null,
      status: d.status ?? null,
      source_link: sourceLink(d),
      requested_by: text(m.requested_by) ?? text(m.requestedBy) ?? null,
      same_title: listed?.same_title ?? 1,
      content: typeof d.raw_content === 'string' ? d.raw_content : null,
      metadata: d.metadata ?? null,
    },
  };
}
