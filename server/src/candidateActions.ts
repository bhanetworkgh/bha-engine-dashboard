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
 */
import * as mirror from './mirror';
import { ADMIN_IDS } from './writeGuards';
import { toolByName, type ToolDeps } from './mcp/tools';
import { McpError } from './mcp/source';
import * as announcer from './patternAnnounce';
import * as drafter from './patternDraft';

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

function deps(): ToolDeps {
  return {
    access: 'page',
    startedAt: new Date().toISOString(),
    // The write handlers never dispatch a page read; the loopback belongs to get_page_data.
    dispatch: async () => ({ status: 404, body: null }),
  };
}

async function call(tool: 'create_record' | 'update_record', args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const t = toolByName(tool, 'write');
  if (!t) throw new Error(`${tool} is not registered`);
  try {
    return (await t.handler(args, deps())) as Record<string, unknown>;
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
}

/**
 * Register: the pattern first, through `create_record`; the candidate only once
 * the pattern is saved. A pattern that saved and a candidate that did not
 * update is said so, with the BP- id, rather than retried or rolled back — the
 * pattern is real, and a second create would make a second one.
 */
export async function register(ref: string, input: RegisterInput): Promise<Record<string, unknown>> {
  const actor = await profile(input.actor_user_id);
  const row = await candidate(ref);
  assertMay(row, actor);
  assertOpen(row, 'registered');
  const fields = Object.fromEntries(Object.entries(input.pattern ?? {}).filter(([, v]) => v !== undefined && v !== null && String(v).trim() !== ''));
  // The page's checklist is one step per line; the pattern guard joins a list with " | ".
  if (typeof fields.implementation_checklist === 'string' && /\n/.test(fields.implementation_checklist)) {
    fields.implementation_checklist = fields.implementation_checklist.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  }
  if (!str(fields.pattern_name)) throw new CandidateError(400, 'missing_required', 'pattern_name is required.');
  const created = await call('create_record', { kind: 'patterns', fields, drafted_by: actor.name, requester_user_id: actor.user_id, dry_run: input.dry_run === true });
  if (created.ok !== true) throw refusedFrom(created, 'The pattern was not created');
  if (input.dry_run === true) return { ok: true, dry_run: true, pattern: created, candidate: row.natural_id ?? ref };
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
  });
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
    ...(marked.ok === true ? {} : { candidate_error: String(marked.message ?? marked.reason ?? 'the candidate was not updated'), note: `The pattern ${patternId} is saved; the candidate still reads ${str(row.fields.Status) ?? 'no status'}. Do not register it again — mark it by hand.` }),
    audit: { pattern: created.audit_id ?? null, candidate: marked.audit_id ?? null, announcement: posted.audit_id },
  };
}

/**
 * "Draft full pattern" (2026-09-24): every field of a pattern from the
 * candidate's Summary and its Slack thread, for the person acting to review.
 * Saves nothing — see patternDraft.ts. The same who-may-act rule as Register,
 * because it is the first half of a Register and it costs a model call.
 * Logged to engine_writes as a read.
 */
export async function draftFor(ref: string, input: { actor_user_id: string | null }): Promise<Record<string, unknown>> {
  const actor = await profile(input.actor_user_id);
  const row = await candidate(ref);
  assertMay(row, actor);
  assertOpen(row, 'drafted');
  const t0 = Date.now();
  try {
    const d = await drafter.draft(row);
    const th = d.sources.thread;
    await mirror.logWrite({
      endpoint: 'page:draft_pattern', kind: 'patterns', method: 'PAGE', key_label: 'session cookie', natural_id: row.natural_id, outcome: 'read', ms: Date.now() - t0,
      detail: `drafted for ${actor.name} with ${d.model}; thread ${th.read ? `${th.messages} messages` : `not read (${th.note})`}; ${d.empty_fields.length} empty: ${d.empty_fields.join(', ') || 'none'}`,
    });
    return d as unknown as Record<string, unknown>;
  } catch (e) {
    if (e instanceof drafter.DraftError) {
      await mirror.logWrite({ endpoint: 'page:draft_pattern', kind: 'patterns', method: 'PAGE', key_label: 'session cookie', natural_id: row.natural_id, outcome: 'error', ms: Date.now() - t0, detail: `${e.reason}: ${e.message}` });
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
