/**
 * Code checks over MCP (29 Oct 2026, Destiny). The rules and the store are ../codeChecks.ts.
 *
 *   `read_code_checks`     — read, both connections; in Bays' and North Star's scopes. What is waiting on a
 *                            check (and what is past Jason's 48 hours), every check posted with its verdict and
 *                            pay call, the discrepancy catalog, and November's outputs for Jason.
 *   `record_code_check`    — write connection, in Bays' scope (D6, 29 Oct). Destiny or Jason records a check
 *                            as posted in the log's thread; on an agent token only Bays, only for Destiny, and
 *                            only for a Slack message Slack confirms Destiny posted. A recorded check is also
 *                            written onto the Codex row (../codeCheckWatch.ts codexNote).
 *   `write_audit_output`   — write connection, no agent's scope, refused on any agent token. Moves one of
 *                            the November outputs (catalog, a lane's definition of done, the v2 spec).
 *
 * Every write call is on engine_mcp_writes, kind code_checks, refused ones included.
 */
import * as codeCheckWatch from '../codeCheckWatch';
import { parseLink, slackAuthor } from '../chargeGate';
import * as cc from '../codeChecks';
import * as mirror from '../mirror';
import { auditClose, auditOpen } from './writeTools';
import type { ToolDefinition, ToolDeps } from './tools';

const str = (args: Record<string, unknown>, key: string): string => (typeof args[key] === 'string' ? (args[key] as string).trim() : '');
const PUBLIC = (process.env.PUBLIC_DASHBOARD_URL?.trim() || 'https://dashboard.bhanetwork.org').replace(/\/$/, '');
export const TAB_URL = `${PUBLIC}/pay?tab=code-checks`;

export const readCodeChecks: ToolDefinition = {
  name: 'read_code_checks',
  description:
    "Destiny's code checks: his second review of every approved builder log against what is actually live (GitHub, Render, n8n, Twilio, the dashboard, BHARAG, vFarm), from 1 Nov 2026, in the format Jason confirmed. Returns what is waiting on a check (approved on the pay ledger, no check yet; late past Jason's 48 hours; Destiny's own logs are not waiting), every check posted with its verdict (matches / partly / overstated), claims, what is missing before customer ready, what could not be checked and the pay call (as logged / partly / hold) with its follow-ups, the discrepancy catalog (every partly or overstated check, with the claims not confirmed), the time from approval to check, and November's outputs for Jason (the catalog, a definition of done checklist per lane, the v2 spec) with their state. codex_entry_id returns one check. Read only.",
  inputSchema: {
    type: 'object',
    properties: {
      codex_entry_id: { type: 'string', description: 'One check, by the log\'s Codex ID.' },
    },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, title: 'Read the code checks and November\'s outputs' },
  handler: async (args, deps) => {
    const t0 = Date.now();
    const id = str(args, 'codex_entry_id');
    const r = await cc.read();
    await mirror.logWrite({ endpoint: 'mcp:read_code_checks', kind: 'code_checks', method: 'MCP', key_label: deps.access === 'write' ? 'MCP_WRITE_TOKEN' : 'MCP_SECRET', outcome: 'read', detail: id || `${r.counts.posted} checks, ${r.counts.waiting} waiting`, ms: Date.now() - t0 });
    if (id) {
      const check = r.checks.find((c) => c.codex_entry_id === id) ?? null;
      const waiting = r.waiting.find((w) => w.codex_entry_id === id) ?? null;
      if (!check && !waiting) return { ok: false, reason: 'not_found', message: `No code check for ${id}, and it is not waiting on one (not approved on the pay ledger since ${cc.START}, or Destiny's own log).` };
      return { ok: true, check, waiting, url: TAB_URL };
    }
    return { ok: true, ...r, url: TAB_URL };
  },
};

async function guarded(
  tool: string,
  args: Record<string, unknown>,
  deps: ToolDeps,
  run: (dry: boolean) => Promise<{ written: boolean; message: string } & Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  const requester = str(args, 'requester_user_id') || null;
  const dry = args.dry_run === true;
  const audit = await auditOpen({ tool, args, access: deps.access, kind: 'code_checks', requester, dry_run: dry });
  if (deps.agent) {
    const refuse = async (reason: string, message: string) => {
      await auditClose(audit, { outcome: 'refused', detail: `${reason}: ${message}`, guard_result: { reason } });
      return { ok: false, written: false, reason, message: `${message} Nothing was changed.`, audit_id: audit };
    };
    // D6 (29 Oct 2026): Bays may record Destiny's posted check, and nothing else. The check must be
    // Destiny's own message in Slack, and Slack must confirm he posted it.
    if (tool !== 'record_code_check' || deps.agent !== 'bays')
      return refuse('agent_not_permitted', `An agent (${deps.agent}) may not write ${tool === 'record_code_check' ? 'a code check' : 'a November output'}: ${tool === 'record_code_check' ? 'only Bays may, and only for a check Destiny posted' : 'Destiny records them'}.`);
    if (requester !== cc.DESTINY) return refuse('not_destinys_check', 'Bays records a code check only for Destiny: requester_user_id must be his Slack id.');
    const link = parseLink(str(args, 'check_link'));
    if (!link) return refuse('check_link_required', 'check_link must be the Slack link (Copy link) of Destiny\'s posted check.');
    if (!dry) {
      const who = await slackAuthor(link);
      if (!who.ok) return refuse(who.reason === 'not_found' ? 'check_not_found' : 'check_unreadable', who.message);
      if (who.user !== cc.DESTINY) return refuse('not_destinys_check', `That message was posted by ${who.user ?? 'someone Slack does not name'}, not Destiny. Bays records only a check Destiny posted himself.`);
    }
  }
  try {
    const r = await run(dry);
    // A recorded check is written onto the log itself (D6). Never able to fail the check: its outcome rides on the answer.
    if (tool === 'record_code_check' && !dry && r.written && r.check) {
      const note = await codeCheckWatch.codexNote(r.check as cc.CodeCheck);
      (r as Record<string, unknown>).codex_note = note;
      if (!note.ok) r.message = `${r.message} The check is recorded, but it was not written onto the log: ${note.detail}`;
      else r.message = `${r.message} Written onto the log (${note.detail}).`;
    }
    const natural = (r.check as cc.CodeCheck | undefined)?.codex_entry_id ?? (r.output as cc.AuditOutput | undefined)?.output_id ?? null;
    await auditClose(audit, { outcome: dry ? 'dry_run' : r.written ? 'updated' : 'unchanged', detail: r.message, natural_id: natural, after: r.check ?? r.output });
    return { ...r, url: TAB_URL, audit_id: audit };
  } catch (e) {
    if (e instanceof cc.CodeCheckError) {
      await auditClose(audit, { outcome: 'refused', detail: `${e.reason}: ${e.message}`, guard_result: { reason: e.reason } });
      return { ok: false, written: false, reason: e.reason, message: `${e.message} Nothing was changed.`, audit_id: audit };
    }
    const message = e instanceof Error ? e.message : String(e);
    await auditClose(audit, { outcome: 'failed', detail: message });
    return { ok: false, written: false, reason: 'error', message: `${message} Nothing was changed.`, raise: true, audit_id: audit };
  }
}

export const recordCodeCheck: ToolDefinition = {
  name: 'record_code_check',
  description: `Record one code check as posted in the log's own thread, or correct one already recorded for that Codex ID. The format Jason confirmed: verdict (${cc.VERDICTS.join(' / ')}) with one line on why; each main claim with where it was checked, the result (${cc.RESULTS.join(' / ')}) and the proof; what is missing before customer ready (${cc.MISSING.join(', ')}); what could not be checked; the pay call (${cc.PAY_CALLS.join(' / ')}) with each follow-up (what, who, by, loop_id). Refused when the verdict and the claims disagree, when pay partly or hold names no follow-up, when an overstated log is paid as logged, and on Destiny's own log. The approval time, builder and session date come from the pay ledger. HELD HERE: Destiny or Jason (requester_user_id). dry_run writes nothing. On an agent token only Bays may call it, only for Destiny (requester_user_id), and only when check_link is a Slack message Slack confirms Destiny posted. A recorded check is also written onto the Codex row (Code Check Verdict, Pay Call, Reason, Link, At, By) and the answer says whether that landed (codex_note). Audited on engine_mcp_writes.`,
  inputSchema: {
    type: 'object',
    properties: {
      codex_entry_id: { type: 'string' },
      check_link: { type: 'string', description: 'The Slack link to the check in the log\'s thread.' },
      posted_at: { type: 'string', description: 'When the check was posted (ISO). Left out: now.' },
      verdict: { type: 'string', enum: [...cc.VERDICTS] },
      verdict_reason: { type: 'string' },
      claims: { type: 'array', items: { type: 'object', properties: { claim: { type: 'string' }, where: { type: 'string' }, result: { type: 'string', enum: [...cc.RESULTS] }, proof: { type: 'string' } }, required: ['claim', 'where', 'result', 'proof'] } },
      missing: { type: 'array', items: { type: 'string', enum: [...cc.MISSING] } },
      couldnt_check: { type: 'string' },
      pay_call: { type: 'string', enum: [...cc.PAY_CALLS] },
      follow_ups: { type: 'array', items: { type: 'object', properties: { what: { type: 'string' }, who: { type: 'string' }, by: { type: 'string' }, loop_id: { type: 'string' } }, required: ['what', 'who', 'by'] } },
      requester_user_id: { type: 'string' },
      dry_run: { type: 'boolean' },
    },
    required: ['codex_entry_id', 'check_link', 'verdict', 'verdict_reason', 'claims', 'pay_call', 'requester_user_id'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false, title: 'Record a code check' },
  handler: (args, deps) => guarded('record_code_check', args, deps, (dry) => cc.recordCheck(args, { dry_run: dry })),
};

export const writeAuditOutput: ToolDefinition = {
  name: 'write_audit_output',
  description: `Create or move one of the outputs Jason asked November to produce: the discrepancy catalog (kind catalog), a lane's definition of done checklist (kind dod_checklist, with lane), or the v2 execution audit spec (kind v2_spec). status is ${cc.OUTPUT_STATUSES.join(' / ')}; link is the document. Leaving a field out keeps it. Accepted needs a note with Jason's message unless Jason sets it. HELD HERE: Destiny or Jason. dry_run writes nothing. Refused on any agent token. Audited on engine_mcp_writes.`,
  inputSchema: {
    type: 'object',
    properties: {
      output_id: { type: 'string', description: 'e.g. discrepancy-catalog, dod-cst-comms, dod-genie-engines, dod-vfarm-p1, dod-ns-comp-infra, v2-execution-audit-spec.' },
      kind: { type: 'string', enum: [...cc.OUTPUT_KINDS] },
      lane: { type: 'string' },
      title: { type: 'string' },
      status: { type: 'string', enum: [...cc.OUTPUT_STATUSES] },
      due: { type: 'string', description: 'YYYY-MM-DD.' },
      link: { type: 'string' },
      note: { type: 'string' },
      requester_user_id: { type: 'string' },
      dry_run: { type: 'boolean' },
    },
    required: ['output_id', 'requester_user_id'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false, title: 'Move a November output' },
  handler: (args, deps) => guarded('write_audit_output', args, deps, (dry) => cc.writeOutput(args, { dry_run: dry })),
};

export const CODE_CHECK_READ_TOOLS: ToolDefinition[] = [readCodeChecks];
export const CODE_CHECK_WRITE_TOOLS: ToolDefinition[] = [recordCodeCheck, writeAuditOutput];
