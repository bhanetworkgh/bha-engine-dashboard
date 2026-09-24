/**
 * Acting on a pattern candidate from the Build patterns page (2026-09-24,
 * Destiny). Until this, architects could see the candidates Bays flags but not
 * act on them, so 47 of 52 sat at Proposed. Three actions:
 *
 *   register  — write the candidate up as a build pattern, then mark it
 *               Registered with the new pattern_id on it.
 *   decline   — Status Declined, with a reason and who declined it.
 *   reassign  — a different Suggested Architect, from Builder Profiles.
 *
 * **One write path, not a second.** Every write here is the MCP write tools'
 * own handler — `create_record` for the pattern (which mints the BP- id, saves,
 * ingests to BHARAG and makes the Google Doc) and `update_record` for the
 * candidate — called with access `page`, so the guards, `engineWrite`, the
 * `engine_writes` line and the `engine_mcp_writes` audit are the ones an MCP
 * call gets, and a page action is told apart on both logs only by its access
 * and its `page:` endpoint.
 *
 * **Who may act** is checked here, before any write: the candidate's suggested
 * architect (`Architect Slack ID`), its builder (`Builder Slack ID`), Jason or
 * Destiny (`ADMIN_IDS`). **The acting person is declared, not authenticated.**
 * This dashboard has one shared login (CLAUDE.md section 4) and no per-person
 * identity, so the page asks who is acting — a Builder Profiles row — and sends
 * that Slack id. The check stops a mistake (acting on somebody else's candidate
 * without meaning to); it cannot stop a signed-in teammate who chooses another
 * name, and nothing here pretends otherwise.
 *
 * **Two doors, one path** (2026-09-25, Destiny). The MCP tools
 * `draft_pattern_candidate` and `register_pattern_candidate`
 * (`mcp/candidateTools.ts`) call `draftFor` and `register` here, the same
 * functions the page's routes call, with `via: 'write'`. The only difference
 * is the label on the logs: `mcp:<tool>` and `MCP_WRITE_TOKEN` rather than
 * `page:<tool>` and the session cookie. Over MCP the acting person is the
 * caller's `requester_user_id`, declared exactly as the page's picker is.
 *
 * **Register ends by deleting the candidate** (2026-09-25, Destiny). Once it
 * is a pattern it lives on the Patterns tab, so the candidate row is marked
 * Registered (the Pattern ID and announcement on it) and then removed through
 * `delete_record`'s own handler, which keeps the whole row in
 * `record_deletions` first. The pipeline figures read that copy back, so a
 * registration still counts after its row has gone.
 */
import * as mirror from './mirror';
import { ADMIN_IDS } from './writeGuards';
import { toolByName, type ToolDeps } from './mcp/tools';
import { McpError } from './mcp/source';
import * as announcer from './patternAnnounce';
import * as drafter from './patternDraft';
import { query } from './pg';
import type { CandidateDays, CandidatePipeline, PatternCandidate, PatternCandidatesData } from '../../src/data/types';

export class CandidateError extends Error {
  constructor(
    public status: number,
    public reason: string,
    message: string,
  ) {
    super(message);
  }
}

/** Where an action cannot go: a candidate already registered or declined is finished. */
const CLOSED = new Set(['Registered', 'Declined']);

export interface Profile {
  user_id: string;
  name: string;
  lane: string | null;
  role: string | null;
}

function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const t = String(v).trim();
  return t ? t : null;
}

/** Every Builder Profiles row, for the acting-as and reassign pickers. */
export async function profiles(): Promise<Profile[]> {
  const r = await mirror.lookup('builder_profiles', { filters: [], limit: 1000, order: 'created_asc' });
  const byId = new Map<string, Profile>();
  for (const row of r.rows) {
    const id = str(row.fields.user_id) ?? row.natural_id;
    const name = str(row.fields.name);
    if (!id || !name) continue;
    byId.set(id, { user_id: id, name, lane: str(row.fields.lane), role: str(row.fields.role) });
  }
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
}

async function profile(userId: string | null): Promise<Profile> {
  if (!userId) throw new CandidateError(400, 'no_actor', 'Say who is acting: pick your name from Builder Profiles.');
  const p = (await profiles()).find((x) => x.user_id === userId);
  if (!p) throw new CandidateError(400, 'unknown_actor', `${userId} has no Builder Profiles row, so this page cannot say who they are. Add the profile first.`);
  return p;
}

/** The page's candidate id: CAND-…, else the Airtable record id, else `row-<id>` — exactly as /api/pattern-candidates names it. */
async function candidate(ref: string): Promise<mirror.LookupRow> {
  const filter: mirror.LookupFilter = ref.startsWith('row-')
    ? { op: 'f', name: 'id', value: ref.slice(4) }
    : ref.startsWith('rec')
      ? { op: 'f', name: 'airtable_record_id', value: ref }
      : { op: 'f', name: 'natural_id', value: ref };
  const r = await mirror.lookup('pattern_candidates', { filters: [filter], limit: 2, order: 'created_desc' });
  if (!r.rows.length) throw new CandidateError(404, 'not_found', `No pattern candidate ${ref} is held.`);
  if (r.rows.length > 1) throw new CandidateError(409, 'ambiguous', `${ref} names ${r.rows.length} candidate rows (${r.rows.map((x) => x.id).join(', ')}); nothing was changed.`);
  return r.rows[0];
}

/** The rule, in one place: the suggested architect, the builder, Jason or Destiny. */
export function mayAct(fields: Record<string, unknown>, actorId: string): boolean {
  return ADMIN_IDS.includes(actorId) || actorId === str(fields['Architect Slack ID']) || actorId === str(fields['Builder Slack ID']);
}

function assertMay(row: mirror.LookupRow, actor: Profile): void {
  if (!mayAct(row.fields, actor.user_id)) {
    const who = [str(row.fields['Suggested Architect']) ?? str(row.fields['Architect Slack ID']), str(row.fields['Builder']) ?? str(row.fields['Builder Slack ID'])].filter(Boolean);
    throw new CandidateError(
      403,
      'not_permitted',
      `${actor.name} may not act on this candidate: only its suggested architect${who.length ? ` or builder (${uniq(who).join(', ')})` : ' or builder'}, Jason or Destiny can. Nothing was changed.`,
    );
  }
}

function assertOpen(row: mirror.LookupRow, action: string): void {
  const status = str(row.fields.Status);
  if (status && CLOSED.has(status)) {
    throw new CandidateError(409, 'already_' + status.toLowerCase(), `This candidate is already ${status}${status === 'Registered' && str(row.fields['Pattern ID']) ? ` as ${str(row.fields['Pattern ID'])}` : ''}, so it cannot be ${action}. Nothing was changed.`);
  }
}

function uniq(xs: (string | null)[]): string[] {
  return [...new Set(xs.filter((x): x is string => Boolean(x)))];
}

/** Which door an action came through: the page (`page`) or the MCP write connection (`write`). */
export type Via = 'page' | 'write';

function deps(via: Via): ToolDeps {
  return {
    access: via,
    startedAt: new Date().toISOString(),
    // The write handlers never dispatch a page read; the loopback belongs to get_page_data.
    dispatch: async () => ({ status: 404, body: null }),
  };
}

async function call(tool: 'create_record' | 'update_record' | 'delete_record', args: Record<string, unknown>, via: Via = 'page'): Promise<Record<string, unknown>> {
  const t = toolByName(tool, 'write');
  if (!t) throw new Error(`${tool} is not registered`);
  try {
    return (await t.handler(args, deps(via))) as Record<string, unknown>;
  } catch (e) {
    if (e instanceof McpError) throw new CandidateError(e.code === 'not_found' ? 404 : e.code === 'ambiguous' ? 409 : 400, e.code, e.message);
    throw e;
  }
}

function refusedFrom(r: Record<string, unknown>, what: string): CandidateError {
  return new CandidateError(422, String(r.reason ?? 'refused'), `${what}: ${String(r.message ?? r.reason ?? 'refused by the write guards')}`);
}

export interface RegisterInput {
  actor_user_id: string | null;
  pattern: Record<string, unknown>;
  dry_run?: boolean;
  via?: Via;
}

/** The page's candidate id: CAND-…, else the Airtable record id, else `row-<id>`. The draft log and the figures key on it. */
export function pageId(row: { id: number | string; natural_id: string | null; airtable_record_id: string | null }): string {
  return row.natural_id ?? row.airtable_record_id ?? `row-${row.id}`;
}

/** What `register` writes when a caller sends no pattern at all: the page form's own seed. */
export function seedPattern(fields: Record<string, unknown>): Record<string, unknown> {
  return { pattern_name: str(fields.Candidate), problem: str(fields.Summary), bha_system: str(fields.Lane), reusability: 'Moderate' };
}

/** The reason a registered candidate's deletion carries; the pipeline figures find handoffs by it. */
export const HANDOFF_REASON = 'Registered as ';

/**
 * Register: the pattern first, through `create_record`; the candidate only once
 * the pattern is saved. A pattern that saved and a candidate that did not
 * update is said so, with the BP- id, rather than retried or rolled back — the
 * pattern is real, and a second create would make a second one.
 */
export async function register(ref: string, input: RegisterInput): Promise<Record<string, unknown>> {
  const via = input.via ?? 'page';
  const actor = await profile(input.actor_user_id);
  const row = await candidate(ref);
  assertMay(row, actor);
  assertOpen(row, 'registered');
  const sent = input.pattern && Object.keys(input.pattern).length ? input.pattern : seedPattern(row.fields);
  const fields = Object.fromEntries(Object.entries(sent).filter(([, v]) => v !== undefined && v !== null && String(v).trim() !== ''));
  // The page's checklist is one step per line; the pattern guard joins a list with " | ".
  if (typeof fields.implementation_checklist === 'string' && /\n/.test(fields.implementation_checklist)) {
    fields.implementation_checklist = fields.implementation_checklist.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  }
  if (!str(fields.pattern_name)) throw new CandidateError(400, 'missing_required', 'pattern_name is required.');
  const created = await call('create_record', { kind: 'patterns', fields, drafted_by: actor.name, requester_user_id: actor.user_id, dry_run: input.dry_run === true }, via);
  if (created.ok !== true) throw refusedFrom(created, 'The pattern was not created');
  if (input.dry_run === true) return { ok: true, dry_run: true, pattern: created, candidate: pageId(row), note: 'Nothing was written. A real register would also announce the pattern, mark the candidate Registered and then delete it (kept in record_deletions).' };
  const patternId = str(created.natural_id);
  const saved = (created.row ?? {}) as { fields?: Record<string, unknown> };
  const pf = saved.fields ?? fields;
  /*
   * The announcement, after the save and never able to undo it (2026-09-24):
   * a post that fails is reported beside the Doc and BHARAG and the pattern
   * stands. It goes out before the candidate is marked so the candidate row
   * can carry the link to its own announcement.
   */
  const posted = await announcer.announce({
    pattern_id: patternId ?? '',
    pattern_row_id: String(created.id ?? ''),
    pattern_name: str(pf.pattern_name) ?? '',
    problem: str(pf.problem) ?? '',
    bha_system: str(pf.bha_system) ?? '',
    reusability: str(pf.reusability) ?? '',
    builder_name: str(row.fields.Builder),
    registered_by_user_id: actor.user_id,
    candidate_id: row.natural_id,
    doc_link: typeof created.doc_link === 'string' ? created.doc_link : null,
    via,
  });
  const now = new Date().toISOString();
  const marked = await call('update_record', {
    kind: 'pattern_candidates',
    id: String(row.id),
    fields: {
      Status: 'Registered',
      'Pattern ID': patternId,
      'Registered At': now,
      'Registered By': actor.name,
      ...(posted.announced ? { 'Announcement Link': posted.permalink ?? `ts ${posted.ts}`, 'Announcement TS': posted.ts } : {}),
    },
    requester_user_id: actor.user_id,
  }, via);
  /*
   * The handoff (2026-09-25): the candidate is now a pattern, so its row goes.
   * Only once it has been marked, so the copy record_deletions keeps carries
   * the Pattern ID and the announcement. A delete that does not land leaves a
   * Registered candidate on the page, which is said, not retried.
   */
  let removed: Record<string, unknown> | null = null;
  if (marked.ok === true) {
    removed = await call('delete_record', {
      kind: 'pattern_candidates',
      id: String(row.id),
      confirm: `DELETE ${row.natural_id ?? row.id}`,
      reason: `${HANDOFF_REASON}${patternId ?? '(no id)'} by ${actor.name}; the candidate now lives on the Build patterns page as that pattern.`,
      requester_user_id: actor.user_id,
    }, via).catch((e: unknown) => ({ ok: false, message: e instanceof Error ? e.message : String(e) }));
  }
  const deleted = removed?.ok === true && removed.deleted === true;
  return {
    ok: marked.ok === true,
    pattern_id: patternId,
    pattern_row_id: created.id,
    pattern_url: `${announcer.dashboardBase()}/build-patterns?open=${encodeURIComponent(`row-${String(created.id)}`)}`,
    doc_created: created.doc_created ?? null,
    doc_id: created.doc_id ?? null,
    doc_link: created.doc_link ?? null,
    doc_error: created.doc_error ?? null,
    ingested_to_bharag: created.ingested_to_bharag ?? null,
    bharag: created.bharag ?? null,
    announced: posted.announced,
    announcement_link: posted.permalink,
    announcement_ts: posted.ts,
    announcement_channel: posted.channel,
    announcement_error: posted.error,
    candidate_updated: marked.ok === true,
    candidate_deleted: deleted,
    ...(deleted ? { candidate_kept_in: 'record_deletions' } : marked.ok === true ? { candidate_delete_error: String(removed?.message ?? removed?.reason ?? 'the candidate was not deleted'), note: `The pattern ${patternId} is saved and the candidate is marked Registered, but its row was not removed from the candidates list. Delete it with delete_record (kind pattern_candidates).` } : {}),
    ...(marked.ok === true ? {} : { candidate_error: String(marked.message ?? marked.reason ?? 'the candidate was not updated'), note: `The pattern ${patternId} is saved; the candidate still reads ${str(row.fields.Status) ?? 'no status'}. Do not register it again — mark it by hand.` }),
    audit: { pattern: created.audit_id ?? null, candidate: marked.audit_id ?? null, candidate_delete: removed?.audit_id ?? null, announcement: posted.audit_id },
  };
}

/**
 * "Draft full pattern" (2026-09-24): every field of a pattern from the
 * candidate's Summary and its Slack thread, for the person acting to review.
 * Saves nothing — see patternDraft.ts. The same who-may-act rule as Register,
 * because it is the first half of a Register and it costs a model call.
 * Logged to engine_writes as a read.
 */
/**
 * Where a draft is logged. Both endpoints are counted by the pipeline figures
 * (`DRAFT_ENDPOINTS`), keyed on the page id, so a draft run from Slack and one
 * run from the page add up to one count per candidate.
 */
export const DRAFT_ENDPOINTS = { page: 'page:draft_pattern', write: 'mcp:draft_pattern_candidate' } as const;

export async function draftFor(ref: string, input: { actor_user_id: string | null; notes?: string | null; codex_entry_id?: string | null; via?: Via }): Promise<Record<string, unknown>> {
  const via = input.via ?? 'page';
  const actor = await profile(input.actor_user_id);
  const row = await candidate(ref);
  assertMay(row, actor);
  assertOpen(row, 'drafted');
  const t0 = Date.now();
  const log = { endpoint: DRAFT_ENDPOINTS[via], kind: 'patterns', method: via === 'page' ? 'PAGE' : 'MCP', key_label: via === 'page' ? 'session cookie' : 'MCP_WRITE_TOKEN', natural_id: pageId(row) };
  try {
    const d = await drafter.draft(row, { notes: input.notes ?? null, codex_entry_id: input.codex_entry_id ?? null });
    const th = d.sources.thread;
    const cx = d.sources.codex;
    await mirror.logWrite({
      ...log, outcome: 'read', ms: Date.now() - t0,
      detail: `drafted for ${actor.name} with ${d.model}; thread ${th.read ? `${th.messages} messages` : `not read (${th.note})`}; codex ${cx.read ? cx.found.join(', ') : 'none'}; notes ${d.sources.notes ? 'yes' : 'no'}; other fields ${d.sources.other_fields.join(', ') || 'none'}; ${d.empty_fields.length} empty: ${d.empty_fields.join(', ') || 'none'}`,
    });
    return d as unknown as Record<string, unknown>;
  } catch (e) {
    if (e instanceof drafter.DraftError) {
      await mirror.logWrite({ ...log, outcome: 'error', ms: Date.now() - t0, detail: `${e.reason}: ${e.message}` });
      throw new CandidateError(e.status, e.reason, e.message);
    }
    throw e;
  }
}

export async function decline(ref: string, input: { actor_user_id: string | null; reason: unknown; dry_run?: boolean }): Promise<Record<string, unknown>> {
  const actor = await profile(input.actor_user_id);
  const reason = str(input.reason);
  if (!reason || reason.length < 3) throw new CandidateError(400, 'no_reason', 'A decline needs a short reason, so the builder and Bays know why.');
  if (reason.length > 1000) throw new CandidateError(400, 'reason_too_long', 'Keep the reason under 1,000 characters.');
  const row = await candidate(ref);
  assertMay(row, actor);
  assertOpen(row, 'declined');
  const r = await call('update_record', {
    kind: 'pattern_candidates',
    id: String(row.id),
    fields: { Status: 'Declined', 'Declined Reason': reason, 'Declined By': actor.name, 'Declined By Slack ID': actor.user_id, 'Declined At': new Date().toISOString() },
    requester_user_id: actor.user_id,
    dry_run: input.dry_run === true,
  });
  if (r.ok !== true) throw refusedFrom(r, 'The candidate was not declined');
  return { ok: true, status: 'Declined', audit_id: r.audit_id ?? null, ...(input.dry_run ? { dry_run: true } : {}) };
}

export async function reassign(ref: string, input: { actor_user_id: string | null; architect_user_id: unknown; dry_run?: boolean }): Promise<Record<string, unknown>> {
  const actor = await profile(input.actor_user_id);
  const to = await profile(str(input.architect_user_id)).catch(() => {
    throw new CandidateError(400, 'unknown_architect', `${String(input.architect_user_id ?? '(none)')} has no Builder Profiles row; pick an architect from the list.`);
  });
  const row = await candidate(ref);
  assertMay(row, actor);
  assertOpen(row, 'reassigned');
  if (str(row.fields['Architect Slack ID']) === to.user_id) throw new CandidateError(409, 'unchanged', `${to.name} is already the suggested architect. Nothing was changed.`);
  const r = await call('update_record', {
    kind: 'pattern_candidates',
    id: String(row.id),
    fields: { 'Suggested Architect': to.name, 'Architect Slack ID': to.user_id, 'Reassigned By': actor.name, 'Reassigned At': new Date().toISOString() },
    requester_user_id: actor.user_id,
    dry_run: input.dry_run === true,
  });
  if (r.ok !== true) throw refusedFrom(r, 'The architect was not changed');
  return { ok: true, suggested_architect: to.name, architect_slack_id: to.user_id, audit_id: r.audit_id ?? null, ...(input.dry_run ? { dry_run: true } : {}) };
}

/* ------------------------------------------------------------ the pipeline */

const DAY = 86_400_000;

/** Date Flagged is a day (YYYY-MM-DD); a full timestamp is read as itself. Null where it is neither. */
function dayMs(v: string | null): number | null {
  if (!v) return null;
  const t = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T00:00:00Z` : v);
  return Number.isFinite(t) ? t : null;
}

function days(ms: number): number {
  return Math.round((ms / DAY) * 10) / 10;
}

/** p50 and p95, nearest rank, over the values given. Never a mean. */
function spread(xs: number[]): CandidateDays {
  if (!xs.length) return { n: 0, p50: null, p95: null };
  const v = [...xs].sort((a, b) => a - b);
  const at = (q: number) => v[Math.min(v.length - 1, Math.max(0, Math.ceil(q * v.length) - 1))];
  return { n: v.length, p50: at(0.5), p95: at(0.95) };
}

/**
 * How the candidate pipeline is moving (2026-09-25, Destiny), added to what
 * `/api/pattern-candidates` answers so the page and get_page_data read one
 * set of figures.
 *
 * Three sources, all already written:
 *   - the live rows;
 *   - `record_deletions`, for the candidates a Register handed off (their
 *     deletion reason starts `Registered as `) — every other deleted candidate
 *     was a test or a mistake and is counted apart, by name, never as a
 *     registration or a decline;
 *   - `engine_writes`, for the draft runs: `page:draft_pattern` and
 *     `mcp:draft_pattern_candidate`, `read` for a draft that reached the model
 *     and `error` for one that did not.
 */
export async function withPipeline(data: Omit<PatternCandidatesData, 'pipeline'>): Promise<PatternCandidatesData> {
  const now = Date.now();
  const [gone, drafts] = await Promise.all([
    query<{ natural_id: string | null; record_id: string; fields: Record<string, unknown> | null; reason: string; at: string }>(
      `SELECT natural_id, record_id, fields, reason, at FROM record_deletions WHERE kind = 'pattern_candidates'`,
    ),
    query<{ natural_id: string | null; outcome: string; n: string; first: string }>(
      `SELECT natural_id, outcome, count(*)::text AS n, min(at) AS first FROM engine_writes WHERE endpoint = ANY($1) GROUP BY natural_id, outcome`,
      [Object.values(DRAFT_ENDPOINTS)],
    ),
  ]);
  const runs = new Map<string, number>();
  const fails = new Map<string, number>();
  let since: string | null = null;
  for (const d of drafts.rows) {
    if (!d.natural_id) continue;
    (d.outcome === 'read' ? runs : fails).set(d.natural_id, ((d.outcome === 'read' ? runs : fails).get(d.natural_id) ?? 0) + Number(d.n));
    if (!since || d.first < since) since = d.first;
  }

  const handedOff = gone.rows.filter((g) => g.reason.startsWith(HANDOFF_REASON));
  const otherGone = gone.rows.length - handedOff.length;
  const live = new Set(data.candidates.map((c) => c.id));
  // A handed-off row with the same id as a live one would be counted twice; the live one wins.
  const handoffs = handedOff
    .map((g) => ({ id: g.natural_id ?? g.record_id, f: g.fields ?? {} }))
    .filter((g, i, all) => !live.has(g.id) && all.findIndex((x) => x.id === g.id) === i);

  const candidates: PatternCandidate[] = data.candidates.map((c) => {
    const flagged = dayMs(c.date_flagged);
    return { ...c, draft_runs: runs.get(c.id) ?? 0, draft_failures: fails.get(c.id) ?? 0, days_in_proposed: c.status === 'Proposed' && flagged !== null ? days(Math.max(0, now - flagged)) : null };
  });

  const count = (st: string) => candidates.filter((c) => c.status === st).length;
  const proposed = candidates.filter((c) => c.status === 'Proposed');
  const known = new Set(['Proposed', 'Approved', 'Registered', 'Declined']);
  const inProposed = proposed.filter((c) => c.days_in_proposed !== null);
  const oldest = inProposed.reduce<PatternCandidate | null>((o, c) => (!o || c.days_in_proposed! > o.days_in_proposed! ? c : o), null);

  // Decision time: Date Flagged to Registered At / Declined At, live and handed off alike.
  const decided: number[] = [];
  const decide = (flagged: unknown, at: unknown) => {
    const a = dayMs(typeof flagged === 'string' ? flagged : null);
    const b = dayMs(typeof at === 'string' ? at : null);
    if (a !== null && b !== null && b >= a) decided.push(days(b - a));
  };
  for (const c of candidates) {
    if (c.status === 'Registered') decide(c.date_flagged, c.registered_at);
    if (c.status === 'Declined') decide(c.date_flagged, c.declined_at);
  }
  for (const h of handoffs) decide(h.f['Date Flagged'], h.f['Registered At']);

  const registeredIds = new Set([...candidates.filter((c) => c.status === 'Registered').map((c) => c.id), ...handoffs.map((h) => h.id)]);
  const drafted = new Set([...runs.keys()].filter((id) => live.has(id) || handoffs.some((h) => h.id === id)));
  const total = candidates.length + handoffs.length;
  const registered = registeredIds.size;
  const declined = count('Declined');
  const otherStatus = candidates.filter((c) => !c.status || !known.has(c.status)).length;

  const notes: string[] = [
    'Durations are p50 and p95 in days, never a mean; Date Flagged is a day, so a candidate flagged today reads under one day.',
    `Registered candidates are removed from the list once they are patterns; the ${handoffs.length} removed so far are read back from record_deletions and counted here.`,
  ];
  if (otherGone) notes.push(`${otherGone} other deleted candidate${otherGone === 1 ? ' was' : 's were'} removed for another reason (a test or a mistake) and ${otherGone === 1 ? 'is' : 'are'} not counted anywhere.`);
  if (otherStatus) notes.push(`${otherStatus} candidate${otherStatus === 1 ? ' carries' : 's carry'} no status or one outside Proposed, Approved, Registered and Declined; counted in the total and in neither rate.`);
  const undated = proposed.length - inProposed.length;
  if (undated) notes.push(`${undated} Proposed candidate${undated === 1 ? ' has' : 's have'} no usable Date Flagged and ${undated === 1 ? 'is' : 'are'} left out of time in Proposed.`);
  notes.push(since ? `Draft runs are counted from the draft log, which begins ${since.slice(0, 10)}; a draft before then was not recorded.` : 'No draft has been run yet, from the page or over MCP.');

  const pipeline: CandidatePipeline = {
    as_of: new Date(now).toISOString(),
    candidates: total,
    proposed: proposed.length,
    approved: count('Approved'),
    registered,
    handed_off: handoffs.length,
    declined,
    other_status: otherStatus,
    register_rate: { n: registered, of: total },
    decline_rate: { n: declined, of: total },
    time_in_proposed: { ...spread(inProposed.map((c) => c.days_in_proposed!)), oldest: oldest?.days_in_proposed ?? null, oldest_id: oldest?.id ?? null, undated },
    time_to_decision: spread(decided),
    drafts: {
      runs: [...runs.values()].reduce((a, b) => a + b, 0),
      failed: [...fails.values()].reduce((a, b) => a + b, 0),
      candidates: drafted.size,
      undecided: candidates.filter((c) => drafted.has(c.id) && (c.status === 'Proposed' || c.status === 'Approved')).length,
      since,
    },
    draft_to_register: { n: [...drafted].filter((id) => registeredIds.has(id)).length, of: drafted.size },
    notes,
  };
  return { ...data, candidates, pipeline };
}
