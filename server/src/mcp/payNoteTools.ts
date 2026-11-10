/**
 * Pay notes over MCP (9 Nov 2026, Destiny). The rules and the store are ../payNote.ts.
 *
 *   `read_pay_notes`   — write connection, no agent's scope, refused on any agent token (agents read no pay).
 *                        Every pay note, the Held list, one log's note with its full history, or a month's
 *                        statement facts.
 *   `set_pay_note`     — write connection, refused on any agent token. Destiny or Jason sets or corrects the
 *                        pay note on an approved log.
 *   `release_pay_note` — write connection, refused on any agent token. Destiny or Jason releases a held share
 *                        with a proof link.
 *
 * Every call is on engine_mcp_writes, kind pay_sessions, refused ones included.
 */
import * as payNote from '../payNote';
import { auditClose, auditOpen } from './writeTools';
import type { ToolDefinition, ToolDeps } from './tools';

const str = (args: Record<string, unknown>, key: string): string => (typeof args[key] === 'string' ? (args[key] as string).trim() : '');
const PUBLIC = (process.env.PUBLIC_DASHBOARD_URL?.trim() || 'https://dashboard.bhanetwork.org').replace(/\/$/, '');
const TAB_URL = `${PUBLIC}/pay?tab=held`;

async function guarded(tool: string, args: Record<string, unknown>, deps: ToolDeps, run: (dry: boolean) => Promise<Record<string, unknown>>): Promise<Record<string, unknown>> {
  const requester = str(args, 'requester_user_id') || null;
  const dry = args.dry_run === true;
  const audit = await auditOpen({ tool, args, access: deps.access, kind: 'pay_sessions', requester, dry_run: dry });
  if (deps.agent) {
    const message = `An agent (${deps.agent}) may not read or change pay: Destiny or Jason does.`;
    await auditClose(audit, { outcome: 'refused', detail: `agent_not_permitted: ${message}`, guard_result: { reason: 'agent_not_permitted' } });
    return { ok: false, written: false, reason: 'agent_not_permitted', message: `${message} Nothing was changed.`, audit_id: audit };
  }
  try {
    const r = await run(dry);
    const written = r.written === true;
    await auditClose(audit, { outcome: tool === 'read_pay_notes' ? 'read' : dry ? 'dry_run' : written ? 'updated' : 'unchanged', detail: String(r.message ?? tool).slice(0, 500), natural_id: str(args, 'codex_entry_id') || str(args, 'submission_id') || null, after: r.note ?? null });
    return { ok: true, ...r, url: TAB_URL, audit_id: audit };
  } catch (e) {
    if (e instanceof payNote.PayNoteError) {
      await auditClose(audit, { outcome: 'refused', detail: `${e.reason}: ${e.message}`, guard_result: { reason: e.reason } });
      return { ok: false, written: false, reason: e.reason, message: `${e.message} Nothing was changed.`, audit_id: audit };
    }
    const message = e instanceof Error ? e.message : String(e);
    await auditClose(audit, { outcome: 'failed', detail: message });
    return { ok: false, written: false, reason: 'error', message: `${message} Nothing was changed.`, raise: true, audit_id: audit };
  }
}

const LOG = {
  submission_id: { type: 'string', description: "The log's Submission ID." },
  codex_entry_id: { type: 'string', description: "The log's Codex Entry ID (either names the log)." },
};

export const readPayNotes: ToolDefinition = {
  name: 'read_pay_notes',
  description:
    'Pay notes on approved logs, in shares of a day (no money): full 1.0, half 0.5, none 0, or a custom fraction; what is credited now, held until a release condition is met, released (with its proof link and month) and docked for good. With no argument: every note and the Held list. With a log (submission_id or codex_entry_id): its note and every change ever made to it. With month (YYYY-MM): the statement facts per builder for that month (credited shares of the month\'s sessions, a log without a note counting as full; shares released that month; everything still held). Destiny or Jason; refused on any agent token.',
  inputSchema: {
    type: 'object',
    properties: { ...LOG, month: { type: 'string', description: 'YYYY-MM for statement facts.' }, pay_mode: { type: 'string', enum: ['Monthly', 'Daily'] }, requester_user_id: { type: 'string' } },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, title: 'Read pay notes' },
  handler: (args, deps) =>
    guarded('read_pay_notes', args, deps, async () => {
      const ref = { submission_id: str(args, 'submission_id'), codex_entry_id: str(args, 'codex_entry_id') };
      if (str(args, 'month')) return { message: 'statement facts', ...(await payNote.statementFacts({ month: str(args, 'month'), pay_mode: str(args, 'pay_mode') || 'Monthly' })) };
      if (ref.submission_id || ref.codex_entry_id) {
        const note = await payNote.get(ref);
        return { message: note ? 'one pay note' : 'no pay note: counts as full', note, counts_as_full: !note, history: await payNote.history(ref) };
      }
      const notes = await payNote.all();
      const held = await payNote.held();
      return { message: `${notes.length} pay note(s), ${held.length} holding a share`, notes, held };
    }),
};

export const setPayNote: ToolDefinition = {
  name: 'set_pay_note',
  description: `Set or correct the pay note on one approved log (Jason, 9 Nov 2026). pay_recommendation: full (1.0), half (0.5 now), none (0 now) or custom_fraction (credited_share, and held_share). For half and none, rest says what happens to the remainder: hold (default, paid once release_condition is met) or dock (never paid). Anything less than full needs reason_tag (${payNote.REASON_TAGS.join(', ')}); anything held needs release_condition in plain words; anything docked needs reason_note. A log that already has a note is corrected forward: correction_note is required, every version is kept, and credited + held can never rise above what the log had (a dock stays docked). decided_by is requester_user_id and must be Destiny or Jason. dry_run writes nothing. Refused on any agent token.`,
  inputSchema: {
    type: 'object',
    properties: {
      ...LOG,
      pay_recommendation: { type: 'string', enum: [...payNote.RECOMMENDATIONS] },
      rest: { type: 'string', enum: ['hold', 'dock'] },
      credited_share: { type: 'number', minimum: 0, maximum: 1 },
      held_share: { type: 'number', minimum: 0, maximum: 1 },
      reason_tag: { type: 'string', enum: [...payNote.REASON_TAGS] },
      reason_note: { type: 'string' },
      release_condition: { type: 'string' },
      correction_note: { type: 'string' },
      requester_user_id: { type: 'string', description: 'Destiny or Jason, the person deciding.' },
      dry_run: { type: 'boolean' },
    },
    required: ['pay_recommendation', 'requester_user_id'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false, title: 'Set a pay note' },
  handler: (args, deps) => guarded('set_pay_note', args, deps, (dry) => payNote.set({ ...args, decided_by: str(args, 'requester_user_id'), via: 'mcp' }, { dry_run: dry }) as unknown as Promise<Record<string, unknown>>),
};

export const releasePayNote: ToolDefinition = {
  name: 'release_pay_note',
  description: 'Release the held share on one log, or several on one proof (submission_ids or codex_entry_ids, up to 50: one merged change often meets the condition on several logs; each is released on its own and one that cannot be is named), once its release condition is met. The whole held share moves to released and is paid in this month\'s statement. Needs proof_link (https: the PR, the engine event, the Slack message that shows the condition met). A docked share is never released. released_by is requester_user_id and must be Destiny or Jason. dry_run writes nothing. Refused on any agent token.',
  inputSchema: {
    type: 'object',
    properties: { ...LOG, submission_ids: { type: 'array', items: { type: 'string' } }, codex_entry_ids: { type: 'array', items: { type: 'string' } }, proof_link: { type: 'string' }, note: { type: 'string' }, requester_user_id: { type: 'string' }, dry_run: { type: 'boolean' } },
    required: ['proof_link', 'requester_user_id'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false, title: 'Release a held pay share' },
  handler: (args, deps) => guarded('release_pay_note', args, deps, (dry) => (Array.isArray(args.submission_ids) || Array.isArray(args.codex_entry_ids) ? payNote.releaseMany({ ...args, released_by: str(args, 'requester_user_id'), via: 'mcp' }, { dry_run: dry }) : payNote.release({ ...args, released_by: str(args, 'requester_user_id'), via: 'mcp' }, { dry_run: dry })) as unknown as Promise<Record<string, unknown>>),
};

export const PAY_NOTE_WRITE_TOOLS: ToolDefinition[] = [readPayNotes, setPayNote, releasePayNote];
