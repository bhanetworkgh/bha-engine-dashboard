/**
 * CST help pages (27 Oct 2026, Destiny — Jason in #bha-coordination 1792702326.928939: Destiny owns
 * cst-help-manuals; Hardik's Honest Gate check is mandatory before anything lands there).
 *
 * The pages the Customer Service Twin will answer pilot operators from, held here so the team can
 * share one link to each and the agents can read them. Migration 98, `engine_help_pages` (one row
 * per page, the text as it stands now) and `engine_help_page_history` (append-only, every change).
 *
 * A page is at one of three stages:
 *   draft      — being written. Open gaps are listed on it by name, with who owes them.
 *   checked    — Hardik passed THIS text against Honest Gate. The check is bound to a sha256 of the
 *                text, so any edit afterwards puts the page back to draft and the old check stays in
 *                the history only.
 *   in_corpus  — the checked text is in BHARAG's cst-help-manuals workspace, with that doc's id.
 *                Only a checked page can get there. This file never writes to BHARAG itself.
 *
 * CST never reads these rows: it answers only from cst-help-manuals. Agents may read every stage,
 * and the read says which stage each page is at, so a draft is never quoted to a customer as final.
 */
import { createHash } from 'node:crypto';
import { query, withTransaction, type Queryable } from './pg';
import { record } from './engineEvents';
import { changed } from './events';
import { parseLink, slackAuthor, type MessageCheck } from './chargeGate';

export const DESTINY = 'U0AEW3TBYH1';
export const JASON = 'U0A9V97949F';
export const HARDIK = 'U0BKT6MAW2Y';

/** Who may write a page: the owner Jason named, and Jason. */
export const EDITORS: ReadonlySet<string> = new Set([DESTINY, JASON]);
/** Who may record a stage: the editors, and Hardik for his own check. */
export const RECORDERS: ReadonlySet<string> = new Set([DESTINY, JASON, HARDIK]);

export const STAGES = ['draft', 'checked', 'in_corpus'] as const;
export type Stage = (typeof STAGES)[number];
export const ACTIONS = ['checked', 'in_corpus', 'back_to_draft'] as const;
export type Action = (typeof ACTIONS)[number];

export const RULE = { title_max: 160, body_max: 40_000, gaps_max: 20, gap_note_max: 400 };

export const RULES = [
  'CST answers customers only from the cst-help-manuals workspace in BHARAG, never from these rows.',
  'A page at draft is unreviewed: never quote it to a customer or a pilot operator as BHA\'s answer. Say it is a draft.',
  'A page at checked has passed Hardik\'s Honest Gate check for exactly this text. It is not in the help library until in_corpus.',
  'An open gap is a part of the page nobody has written yet. Never fill it in: say who owes it.',
  'Any edit to a checked page puts it back to draft until Hardik checks it again.',
];

export class HelpPageError extends Error {
  constructor(public reason: string, message: string) {
    super(message);
  }
}

export interface Gap {
  id: string;
  owner: string;
  note: string;
}

export interface HelpPage {
  page_id: string;
  title: string;
  body: string;
  body_sha256: string;
  gaps: Gap[];
  sources: string | null;
  stage: Stage;
  checked_by: string | null;
  checked_at: string | null;
  checked_sha256: string | null;
  check_evidence: string | null;
  bharag_doc_id: string | null;
  in_corpus_at: string | null;
  sort: number;
  updated_by: string;
  updated_at: string;
  created_at: string;
}

export interface HistoryRow {
  id: number;
  page_id: string;
  action: string;
  actor: string;
  note: string | null;
  body_sha256: string | null;
  stage_before: string | null;
  stage_after: string | null;
  evidence: string | null;
  at: string;
}

export const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

const iso = (v: unknown): string | null => (v == null ? null : v instanceof Date ? v.toISOString() : String(v));

function toPage(r: Record<string, unknown>): HelpPage {
  return {
    page_id: String(r.page_id),
    title: String(r.title),
    body: String(r.body),
    body_sha256: String(r.body_sha256),
    gaps: Array.isArray(r.gaps) ? (r.gaps as Gap[]) : [],
    sources: (r.sources as string) ?? null,
    stage: r.stage as Stage,
    checked_by: (r.checked_by as string) ?? null,
    checked_at: iso(r.checked_at),
    checked_sha256: (r.checked_sha256 as string) ?? null,
    check_evidence: (r.check_evidence as string) ?? null,
    bharag_doc_id: (r.bharag_doc_id as string) ?? null,
    in_corpus_at: iso(r.in_corpus_at),
    sort: Number(r.sort ?? 0),
    updated_by: String(r.updated_by),
    updated_at: iso(r.updated_at) ?? '',
    created_at: iso(r.created_at) ?? '',
  };
}

/** What the page and the read tool print for a stage. Draft with gaps reads "gaps open". */
export function stageLabel(p: Pick<HelpPage, 'stage' | 'gaps'>): string {
  if (p.stage === 'in_corpus') return 'In cst-help-manuals';
  if (p.stage === 'checked') return 'Checked by Hardik';
  return p.gaps.length ? `Draft, ${p.gaps.length} gap${p.gaps.length === 1 ? '' : 's'} open` : 'Draft';
}

const PAGE_ID = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/;

/** Cleans a gap list, pure. Throws naming the rule. */
export function cleanGaps(v: unknown): Gap[] {
  if (v == null) return [];
  if (!Array.isArray(v)) throw new HelpPageError('bad_gaps', 'gaps must be a list of {id, owner, note}.');
  if (v.length > RULE.gaps_max) throw new HelpPageError('bad_gaps', `At most ${RULE.gaps_max} gaps on a page.`);
  const seen = new Set<string>();
  return v.map((g, i) => {
    const o = (g ?? {}) as Record<string, unknown>;
    const id = typeof o.id === 'string' ? o.id.trim() : '';
    const owner = typeof o.owner === 'string' ? o.owner.trim() : '';
    const note = typeof o.note === 'string' ? o.note.trim() : '';
    if (!PAGE_ID.test(id)) throw new HelpPageError('bad_gaps', `Gap ${i + 1}: id must be lower case letters, digits and hyphens.`);
    if (seen.has(id)) throw new HelpPageError('bad_gaps', `Gap id "${id}" is listed twice.`);
    seen.add(id);
    if (!owner) throw new HelpPageError('bad_gaps', `Gap "${id}" needs an owner: who is writing it.`);
    if (!note || note.length > RULE.gap_note_max) throw new HelpPageError('bad_gaps', `Gap "${id}" needs a note of 1 to ${RULE.gap_note_max} characters saying what is missing.`);
    return { id, owner: owner.slice(0, 80), note };
  });
}

export async function list(): Promise<HelpPage[]> {
  const r = await query(`SELECT * FROM engine_help_pages ORDER BY sort, page_id`);
  return r.rows.map(toPage);
}

export async function get(page_id: string, db?: Queryable): Promise<HelpPage | null> {
  const q = db ? db.query.bind(db) : query;
  const r = await q(`SELECT * FROM engine_help_pages WHERE page_id = $1`, [page_id]);
  return r.rows[0] ? toPage(r.rows[0] as Record<string, unknown>) : null;
}

export async function history(page_id?: string, limit = 100): Promise<HistoryRow[]> {
  const r = await query(
    `SELECT * FROM engine_help_page_history ${page_id ? 'WHERE page_id = $1' : ''} ORDER BY at DESC, id DESC LIMIT ${Math.min(500, Math.max(1, limit))}`,
    page_id ? [page_id] : [],
  );
  return r.rows.map((x) => ({
    id: Number(x.id),
    page_id: String(x.page_id),
    action: String(x.action),
    actor: String(x.actor),
    note: (x.note as string) ?? null,
    body_sha256: (x.body_sha256 as string) ?? null,
    stage_before: (x.stage_before as string) ?? null,
    stage_after: (x.stage_after as string) ?? null,
    evidence: (x.evidence as string) ?? null,
    at: iso(x.at) ?? '',
  }));
}

async function logHistory(db: Queryable, h: Omit<HistoryRow, 'id' | 'at'>): Promise<void> {
  await db.query(
    `INSERT INTO engine_help_page_history (page_id, action, actor, note, body_sha256, stage_before, stage_after, evidence) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [h.page_id, h.action, h.actor, h.note, h.body_sha256, h.stage_before, h.stage_after, h.evidence],
  );
}

export interface WriteInput {
  page_id: string;
  title?: string | null;
  body?: string | null;
  gaps?: unknown;
  sources?: string | null;
  note?: string | null;
  requester_user_id: string;
}

/**
 * Creates or changes one page. Only the text, title, gaps and sources; never the stage, except that
 * a changed text on a checked or in_corpus page goes back to draft (the check was of other words).
 */
export async function write(i: WriteInput, opts: { dry_run?: boolean } = {}): Promise<{ ok: true; written: boolean; created: boolean; page: HelpPage; message: string }> {
  const who = (i.requester_user_id ?? '').trim();
  if (!EDITORS.has(who)) throw new HelpPageError('not_permitted', 'Only Destiny (who owns cst-help-manuals) or Jason may write a help page.');
  const page_id = (i.page_id ?? '').trim();
  if (!PAGE_ID.test(page_id)) throw new HelpPageError('bad_page_id', 'page_id must be 3 to 64 lower case letters, digits and hyphens, e.g. operator-quickstart.');
  return withTransaction(async (db) => {
    const cur = await db.query(`SELECT * FROM engine_help_pages WHERE page_id = $1 FOR UPDATE`, [page_id]);
    const before = cur.rows[0] ? toPage(cur.rows[0] as Record<string, unknown>) : null;
    const title = i.title != null ? String(i.title).trim() : before?.title ?? '';
    const body = i.body != null ? String(i.body).replace(/\r\n/g, '\n').trim() : before?.body ?? '';
    if (!title || title.length > RULE.title_max) throw new HelpPageError('bad_title', `title is required, 1 to ${RULE.title_max} characters.`);
    if (!body || body.length > RULE.body_max) throw new HelpPageError('bad_body', `body is required, 1 to ${RULE.body_max} characters of markdown.`);
    const gaps = i.gaps !== undefined ? cleanGaps(i.gaps) : before?.gaps ?? [];
    const sources = i.sources !== undefined ? (i.sources ? String(i.sources).trim().slice(0, 2000) : null) : before?.sources ?? null;
    const body_sha256 = sha(body);
    const textChanged = !before || before.body_sha256 !== body_sha256 || before.title !== title;
    const sameAll = before && !textChanged && JSON.stringify(before.gaps) === JSON.stringify(gaps) && before.sources === sources;
    if (sameAll) return { ok: true as const, written: false, created: false, page: before!, message: `${page_id} already reads exactly that. Nothing changed.` };
    const stage: Stage = !before ? 'draft' : textChanged ? 'draft' : before.stage;
    const back = before && before.stage !== 'draft' && stage === 'draft';
    const next: HelpPage = {
      ...(before ?? ({ checked_by: null, checked_at: null, checked_sha256: null, check_evidence: null, bharag_doc_id: null, in_corpus_at: null, sort: 100, created_at: new Date().toISOString() } as HelpPage)),
      page_id, title, body, body_sha256, gaps, sources, stage,
      updated_by: who, updated_at: new Date().toISOString(),
    } as HelpPage;
    if (back) Object.assign(next, { checked_by: null, checked_at: null, checked_sha256: null, check_evidence: null, bharag_doc_id: null, in_corpus_at: null });
    const message = !before
      ? `Created ${page_id} as a draft${gaps.length ? ` with ${gaps.length} open gap(s)` : ''}.`
      : back
        ? `Changed ${page_id}. It was ${stageLabel(before)}; the text changed, so it is a draft again until Hardik checks it.`
        : `Changed ${page_id} (${textChanged ? 'text' : 'gaps or sources'}). Stage: ${stageLabel(next)}.`;
    if (opts.dry_run) return { ok: true as const, written: false, created: !before, page: next, message: `Dry run: ${message} Nothing was written.` };
    if (!before) {
      await db.query(
        `INSERT INTO engine_help_pages (page_id, title, body, body_sha256, gaps, sources, stage, sort, updated_by) VALUES ($1,$2,$3,$4,$5::jsonb,$6,'draft',COALESCE((SELECT max(sort)+1 FROM engine_help_pages),1),$7)`,
        [page_id, title, body, body_sha256, JSON.stringify(gaps), sources, who],
      );
    } else {
      await db.query(
        `UPDATE engine_help_pages SET title=$2, body=$3, body_sha256=$4, gaps=$5::jsonb, sources=$6, stage=$7, updated_by=$8, updated_at=now()
           ${back ? ', checked_by=NULL, checked_at=NULL, checked_sha256=NULL, check_evidence=NULL, bharag_doc_id=NULL, in_corpus_at=NULL' : ''}
         WHERE page_id=$1`,
        [page_id, title, body, body_sha256, JSON.stringify(gaps), sources, stage, who],
      );
    }
    await logHistory(db, { page_id, action: before ? 'edited' : 'created', actor: who, note: (i.note ?? '').trim().slice(0, 1000) || null, body_sha256, stage_before: before?.stage ?? null, stage_after: stage, evidence: null });
    await record({ event_type: 'help_page_written', subject_id: page_id, lane: 'CST', actor: who, detail: { created: !before, text_changed: textChanged, stage_before: before?.stage ?? null, stage_after: stage, gaps: gaps.length, body_sha256 } }, db);
    changed('help_pages', page_id, db);
    const page = (await get(page_id, db))!;
    return { ok: true as const, written: true, created: !before, page, message };
  });
}

export interface StageInput {
  page_id: string;
  action: string;
  requester_user_id: string;
  /** checked: Hardik's own Slack message passing this page. */
  evidence_link?: string | null;
  /** in_corpus: the BHARAG document id in cst-help-manuals. */
  bharag_doc_id?: string | null;
  /** The sha256 the caller read, so a check is never recorded against text that has since changed. */
  body_sha256?: string | null;
  note?: string | null;
}

/** Moves a page to checked, in_corpus, or back to draft. Every rule refuses by name and writes nothing. */
export async function setStage(i: StageInput, opts: { dry_run?: boolean; checkMessage?: MessageCheck } = {}): Promise<{ ok: true; written: boolean; page: HelpPage; message: string }> {
  const who = (i.requester_user_id ?? '').trim();
  if (!RECORDERS.has(who)) throw new HelpPageError('not_permitted', 'Only Destiny, Jason or Hardik may record a help page\'s stage.');
  const action = (i.action ?? '').trim() as Action;
  if (!(ACTIONS as readonly string[]).includes(action)) throw new HelpPageError('bad_action', `action is one of ${ACTIONS.join(', ')}.`);
  const page = await get((i.page_id ?? '').trim());
  if (!page) throw new HelpPageError('not_found', `No help page "${i.page_id}".`);
  const sentSha = (i.body_sha256 ?? '').trim();
  if (sentSha && sentSha !== page.body_sha256) throw new HelpPageError('text_changed', `${page.page_id} has changed since you read it. Read it again and check the text as it stands now.`);
  let evidence: string | null = null;
  let link: ReturnType<typeof parseLink> = null;
  if (action === 'checked') {
    if (page.stage !== 'draft') throw new HelpPageError('wrong_stage', `${page.page_id} is ${stageLabel(page)}, not a draft.`);
    if (who !== HARDIK && who !== DESTINY && who !== JASON) throw new HelpPageError('not_permitted', 'Only Hardik, or Destiny or Jason recording Hardik\'s check, may mark a page checked.');
    evidence = (i.evidence_link ?? '').trim();
    link = parseLink(evidence);
    if (!link) throw new HelpPageError('evidence_required', 'A check needs evidence_link: the Slack link to Hardik\'s own message passing this page.');
  } else if (action === 'in_corpus') {
    if (page.stage !== 'checked') throw new HelpPageError('wrong_stage', `${page.page_id} is ${stageLabel(page)}. Only a page Hardik has checked goes into cst-help-manuals.`);
    if (page.checked_sha256 !== page.body_sha256) throw new HelpPageError('text_changed', `${page.page_id}'s text is not the text Hardik checked.`);
    if (who !== DESTINY && who !== JASON) throw new HelpPageError('not_permitted', 'Only Destiny or Jason records a page as in cst-help-manuals.');
    evidence = (i.bharag_doc_id ?? '').trim();
    if (!evidence || evidence.length > 120) throw new HelpPageError('bharag_doc_id_required', 'in_corpus needs bharag_doc_id: the id of this page\'s document in cst-help-manuals.');
  } else {
    if (page.stage === 'draft') throw new HelpPageError('wrong_stage', `${page.page_id} is already a draft.`);
    if (who !== DESTINY && who !== JASON && who !== HARDIK) throw new HelpPageError('not_permitted', 'Not permitted.');
    if (!(i.note ?? '').trim()) throw new HelpPageError('note_required', 'Say why it goes back to draft (note).');
  }
  const stage: Stage = action === 'back_to_draft' ? 'draft' : action;
  const label = action === 'checked' ? 'checked by Hardik' : action === 'in_corpus' ? 'in cst-help-manuals' : 'back to draft';
  if (link && !opts.dry_run) {
    const seen = await (opts.checkMessage ?? slackAuthor)(link);
    if (!seen.ok) throw new HelpPageError(seen.reason === 'not_found' ? 'evidence_not_found' : 'evidence_unchecked', `${seen.message} Nothing was recorded: a check counts only on a message Slack confirms is Hardik's.`);
    if (seen.user !== HARDIK) throw new HelpPageError('evidence_not_hardiks', `That message was posted by ${seen.user ?? 'a bot or an unknown sender'}, not Hardik. Link Hardik's own message.`);
  }
  if (opts.dry_run) return { ok: true, written: false, page: { ...page, stage }, message: `Dry run: ${page.page_id} would be ${label}.${link ? ' The Slack author is checked on the real call.' : ''} Nothing was written.` };
  return withTransaction(async (db) => {
    const r = await db.query(
      action === 'checked'
        ? `UPDATE engine_help_pages SET stage='checked', checked_by=$2, checked_at=now(), checked_sha256=body_sha256, check_evidence=$3, updated_at=now(), updated_by=$4 WHERE page_id=$1 AND stage='draft' AND body_sha256=$5`
        : action === 'in_corpus'
          ? `UPDATE engine_help_pages SET stage='in_corpus', bharag_doc_id=$3, in_corpus_at=now(), updated_at=now(), updated_by=$4 WHERE page_id=$1 AND stage='checked' AND body_sha256=$5 AND $2::text IS NOT NULL`
          : `UPDATE engine_help_pages SET stage='draft', checked_by=NULL, checked_at=NULL, checked_sha256=NULL, check_evidence=NULL, bharag_doc_id=NULL, in_corpus_at=NULL, updated_at=now(), updated_by=$4 WHERE page_id=$1 AND stage<>'draft' AND body_sha256=$5 AND $2::text IS NOT NULL AND $3::text IS NULL`,
      [page.page_id, HARDIK, action === 'back_to_draft' ? null : evidence, who, page.body_sha256],
    );
    if (!r.rowCount) throw new HelpPageError('text_changed', `${page.page_id} changed while this was being recorded. Read it again.`);
    await logHistory(db, { page_id: page.page_id, action, actor: who, note: (i.note ?? '').trim().slice(0, 1000) || null, body_sha256: page.body_sha256, stage_before: page.stage, stage_after: stage, evidence });
    await record({ event_type: 'help_page_stage_changed', subject_id: page.page_id, lane: 'CST', actor: who, source_ref: action === 'checked' ? evidence : null, detail: { action, stage_before: page.stage, stage_after: stage, body_sha256: page.body_sha256, bharag_doc_id: action === 'in_corpus' ? evidence : null } }, db);
    changed('help_pages', page.page_id, db);
    const after = (await get(page.page_id, db))!;
    return { ok: true as const, written: true, page: after, message: `${page.page_id} is now ${label}.` };
  });
}

/** The page's route and the read tool's answer. */
export async function read(): Promise<{ pages: Array<HelpPage & { stage_label: string; customer_safe: boolean }>; counts: Record<Stage, number> & { gaps_open: number }; rules: string[] }> {
  const pages = await list();
  const counts = { draft: 0, checked: 0, in_corpus: 0, gaps_open: 0 } as Record<Stage, number> & { gaps_open: number };
  for (const p of pages) {
    counts[p.stage]++;
    counts.gaps_open += p.gaps.length;
  }
  return { pages: pages.map((p) => ({ ...p, stage_label: stageLabel(p), customer_safe: p.stage === 'in_corpus' })), counts, rules: RULES };
}
