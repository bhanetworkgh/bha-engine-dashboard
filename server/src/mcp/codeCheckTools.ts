/**
 * Code checks over MCP (29 Oct 2026, Destiny). The rules and the store are ../codeChecks.ts.
 *
 *   `read_code_checks`     — read, both connections; in Bays' and North Star's scopes. What is waiting on a
 *                            check (and what is past Jason's 48 hours), every check posted with its verdict and
 *                            pay call, the discrepancy catalog, and November's outputs for Jason.
 *   `record_code_check`    — write connection, no agent's scope, refused on any agent token. Destiny or Jason
 *                            records a check as posted in the log's thread, and it is also written onto the
 *                            Codex row (../codeCheckWatch.ts codexNote).
 *   `write_audit_output`   — write connection, no agent's scope, refused on any agent token. Moves one of
 *                            the November outputs (catalog, a lane's definition of done, the v2 spec).
 *
 * Every write call is on engine_mcp_writes, kind code_checks, refused ones included.
 */
import * as codeCheckWatch from '../codeCheckWatch';
import * as draft from '../codeCheckDraft';
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
    // Destiny records his checks through the connector (29 Oct 2026: a Slack path through Bays is not needed).
    const message = `An agent (${deps.agent}) may not write a code check or a November output: Destiny records them.`;
    await auditClose(audit, { outcome: 'refused', detail: `agent_not_permitted: ${message}`, guard_result: { reason: 'agent_not_permitted' } });
    return { ok: false, written: false, reason: 'agent_not_permitted', message: `${message} Nothing was changed.`, audit_id: audit };
  }
  try {
    const r = await run(dry);
    // A recorded check is written onto the log itself (D6). Never able to fail the check: its outcome rides on the answer.
    if (tool === 'record_code_check' && !dry && r.written && r.check) {
      const a = await codeCheckWatch.afterRecord(r.check as cc.CodeCheck);
      Object.assign(r, a);
      r.message = a.codex_note.ok ? `${r.message} Written onto the log (${a.codex_note.detail}).` : `${r.message} The check is recorded, but it was not written onto the log: ${a.codex_note.detail}`;
      r.message = a.bharag_note.ok ? `${r.message} Written onto BHARAG (${a.bharag_note.detail}).` : `${r.message} Not written onto BHARAG: ${a.bharag_note.detail}`;
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
  description: `Record one code check as posted in the log's own thread, or correct one already recorded for that Codex ID. The format Jason confirmed: verdict (${cc.VERDICTS.join(' / ')}) with one line on why; each main claim with where it was checked, the result (${cc.RESULTS.join(' / ')}) and the proof; what is missing before customer ready (${cc.MISSING.join(', ')}); what could not be checked; the pay call (${cc.PAY_CALLS.join(' / ')}) with each follow-up (what, who, by, loop_id); and the Bays summary Jason asked for: approve (yes / no: did this move the lane towards its goal), approve_why (one line), lane_goal and lane_check. A no does not change the pay call. Refused when the verdict and the claims disagree, when pay partly or hold names no follow-up, when an overstated log is paid as logged, when an overstated or held log is approved yes, and on Destiny's own log. The approval time, builder and session date come from the pay ledger. HELD HERE: Destiny or Jason (requester_user_id). dry_run writes nothing. Refused on any agent token. A recorded check is also written onto the Codex row (Code Check Verdict, Pay Call, Reason, Approve, Why, Lane Goal, Lane, Link, At, By) and onto the entry's own document in BHARAG as metadata code_check, in place with the same id; the answer says whether each landed (codex_note, bharag_note). Audited on engine_mcp_writes.`,
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
      approve: { type: 'string', enum: [...cc.APPROVALS], description: 'Did this work move the lane towards its goal. Does not change the pay call.' },
      approve_why: { type: 'string', description: 'One clear line.' },
      lane_goal: { type: 'string', description: 'What this lane is trying to do.' },
      lane_check: { type: 'string', description: 'How this work moves it, or why it does not.' },
      requester_user_id: { type: 'string' },
      dry_run: { type: 'boolean' },
    },
    required: ['codex_entry_id', 'check_link', 'verdict', 'verdict_reason', 'claims', 'pay_call', 'approve', 'approve_why', 'lane_goal', 'lane_check', 'requester_user_id'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false, title: 'Record a code check' },
  handler: (args, deps) => guarded('record_code_check', args, deps, (dry) => cc.recordCheck(args, { dry_run: dry })),
};

export const prepareCodeCheck: ToolDefinition = {
  name: 'prepare_code_check',
  description: `Save a code check as ready to send, once Destiny has heard it and agreed it. Give everything record_code_check takes except check_link, plus draft_text: the check exactly as it will be drafted on Slack. Marks the log's card reviewed at the same moment, since the review is done once the check is drafted. Answers with the channel and thread to draft into. When he sends that draft, the check records itself from his message (Codex, BHARAG, the review card) and a line confirms it in the thread, so do not call record_code_check afterwards. The draft ends with the Bays summary, including a line reading "Approve: yes" or "Approve: no". A verdict, pay call or Approve changed before sending stops it and says so. Preparing again replaces the earlier one.`,
  inputSchema: {
    type: 'object',
    properties: {
      ...(recordCodeCheck.inputSchema as { properties: Record<string, unknown> }).properties,
      draft_text: { type: 'string', description: 'The check as drafted on Slack: opens "Code check:" and names the Codex ID.' },
      readiness: { type: 'string', enum: [...cc.READINESS], description: `Jason's rule. no_gate only outside the gated lanes (${cc.GATED_LANES.join(', ')}). blocked_on_gate when the gate is not passed. customer_ready only when gate_ref is a closed loop.` },
      gate: { type: 'string', description: `The stage gate by name, for example ${cc.DEFAULT_GATE}.` },
      gate_ref: { type: 'string', description: 'The gate loop id, for example LOOP-1791428275782-TU4O.' },
      channel_id: { type: 'string', description: 'Only when the posted Codex cannot be found.' },
      thread_ts: { type: 'string', description: 'Only when the posted Codex cannot be found.' },
    },
    required: ['codex_entry_id', 'draft_text', 'verdict', 'verdict_reason', 'claims', 'couldnt_check', 'readiness', 'pay_call', 'approve', 'approve_why', 'lane_goal', 'lane_check', 'requester_user_id'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false, title: 'Save a code check as ready to send' },
  handler: (args, deps) => guarded('prepare_code_check', args, deps, (dry) => codeCheckWatch.prepare(args, { dry_run: dry })),
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


export const codeCheckAlertTrial: ToolDefinition = {
  name: 'code_check_alert_trial',
  description: `Switch the code check alert's trial on or off, or read it (action on / off / status). Before ${cc.START} the alert and the 3-hourly reminders only fire for approvals on or after that date; the trial (Destiny, 29 Oct 2026) makes them fire for approvals from the moment it is switched on (or from \`from\`, an ISO time), so they can be proven on real logs, then switched off. It changes only what the alert fires on: the Code checks tab, its waiting list and its figures still start at ${cc.START}. HELD HERE: Destiny or Jason (requester_user_id). Refused on any agent token. Audited on engine_mcp_writes.`,
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['on', 'off', 'status'] },
      from: { type: 'string', description: 'ISO time alerts count from while on; defaults to now.' },
      requester_user_id: { type: 'string' },
    },
    required: ['action', 'requester_user_id'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false, title: 'Switch the code check alert trial' },
  handler: async (args, deps) => {
    const action = str(args, 'action');
    const requester = str(args, 'requester_user_id') || null;
    if (action === 'status') return { ok: true, trial: await codeCheckWatch.trial(), alerts_from: codeCheckWatch.alertsFrom(await codeCheckWatch.trial()) };
    const audit = await auditOpen({ tool: 'code_check_alert_trial', args, access: deps.access, kind: 'code_checks', requester, dry_run: false });
    const refuse = async (reason: string, message: string) => {
      await auditClose(audit, { outcome: 'refused', detail: `${reason}: ${message}`, guard_result: { reason } });
      return { ok: false, reason, message: `${message} Nothing was changed.`, audit_id: audit };
    };
    if (deps.agent) return refuse('agent_not_permitted', `An agent (${deps.agent}) may not switch the trial.`);
    if (!requester || !cc.RECORDERS.has(requester)) return refuse('not_permitted', 'Only Destiny or Jason may switch the trial.');
    if (action !== 'on' && action !== 'off') return refuse('bad_action', 'action must be on, off or status.');
    let from: string | null = null;
    if (action === 'on') {
      const given = str(args, 'from');
      const d = given ? new Date(given) : new Date();
      if (Number.isNaN(d.getTime())) return refuse('bad_from', 'from must be an ISO time with its zone.');
      from = d.toISOString();
    }
    const t = await codeCheckWatch.setTrial(action === 'on', requester, from);
    const message = t.on
      ? `Trial on: approvals from ${t.from} now alert Destiny within about 2 minutes, then remind every 3 hours until a check is recorded. Switch it off once it is proven.`
      : `Trial off: the alert fires again only for approvals on or after ${cc.START}.`;
    await auditClose(audit, { outcome: 'updated', detail: message, after: t });
    return { ok: true, trial: t, alerts_from: codeCheckWatch.alertsFrom(t), message, audit_id: audit };
  },
};

export const syncCodeCheckToBharag: ToolDefinition = {
  name: 'sync_code_check_to_bharag',
  description: 'Write a code check already recorded onto its Codex entry\'s own document in BHARAG, in place (same id, metadata key code_check, nothing else touched). For a check recorded before this went in, or one whose BHARAG write was refused. record_code_check does this by itself for every new check. Finds every document in the Codex workspace whose metadata codex_entry_id is the entry. dry_run finds them and edits nothing. HELD HERE: Destiny or Jason. Refused on any agent token. Audited on engine_mcp_writes.',
  inputSchema: {
    type: 'object',
    properties: {
      codex_entry_id: { type: 'string' },
      requester_user_id: { type: 'string' },
      dry_run: { type: 'boolean' },
    },
    required: ['codex_entry_id', 'requester_user_id'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true, title: 'Write a code check onto BHARAG' },
  handler: async (args, deps) => {
    const id = str(args, 'codex_entry_id');
    const requester = str(args, 'requester_user_id');
    const dry = args.dry_run === true;
    const audit = await auditOpen({ tool: 'sync_code_check_to_bharag', args, access: deps.access, kind: 'code_checks', requester: requester || null, dry_run: dry });
    const refuse = async (reason: string, message: string) => {
      await auditClose(audit, { outcome: 'refused', detail: `${reason}: ${message}`, guard_result: { reason } });
      return { ok: false, reason, message: `${message} Nothing was changed.`, audit_id: audit };
    };
    if (deps.agent) return refuse('agent_not_permitted', `An agent (${deps.agent}) may not write a code check.`);
    if (!cc.RECORDERS.has(requester)) return refuse('not_permitted', 'Only Destiny or Jason may write a code check.');
    const r = await cc.read();
    const check = r.checks.find((c) => c.codex_entry_id === id);
    if (!check) return refuse('not_found', `No code check is recorded for ${id}.`);
    const note = await codeCheckWatch.bharagNote(check, { dry_run: dry });
    await auditClose(audit, { outcome: dry ? 'dry_run' : note.ok ? 'updated' : 'failed', detail: note.detail, natural_id: id });
    return { ok: note.ok, written: !dry && note.edited.length > 0, documents: note.documents, edited: note.edited, message: note.detail, audit_id: audit, ...(note.ok || dry ? {} : { raise: true }) };
  },
};

export const submitCodeCheckDraft: ToolDefinition = {
  name: 'submit_code_check_draft',
  description: 'Hand back the finished automatic code check. Only while that round is running. Nothing reaches the builder: Bays posts it as a card in #bha-code-reviews for Destiny. Takes codex_entry_id, round, draft_text and the fields of a check. A refusal names what to fix; fix it and call again.',
  inputSchema: {
    type: 'object',
    properties: { ...(prepareCodeCheck.inputSchema as { properties: Record<string, unknown> }).properties, round: { type: 'number' } },
    required: ['codex_entry_id', 'round', 'draft_text', 'verdict', 'verdict_reason', 'claims', 'couldnt_check', 'readiness', 'pay_call', 'approve', 'approve_why', 'lane_goal', 'lane_check'],
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false, title: 'Hand back an automatic code check' },
  handler: async (args, deps) => {
    const audit = await auditOpen({ tool: 'submit_code_check_draft', args, access: deps.access, kind: 'code_checks', requester: null, dry_run: false });
    const r = await draft.submit(args);
    await auditClose(audit, { outcome: r.ok ? 'updated' : 'refused', detail: String(r.message), natural_id: str(args, 'codex_entry_id') });
    return { ...r, audit_id: audit };
  },
};

export const startCodeCheck: ToolDefinition = {
  name: 'start_code_check',
  description: 'Run the automatic code check on one approved log now (codex_entry_id), or switch automatic starts on or off (auto: true or false; on covers logs approved from that moment). Destiny or Jason. Refused on any agent token. The check lands as a card in #bha-code-reviews.',
  inputSchema: {
    type: 'object',
    properties: { codex_entry_id: { type: 'string' }, auto: { type: 'boolean' }, requester_user_id: { type: 'string' } },
    required: ['requester_user_id'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true, title: 'Start the automatic code check' },
  handler: async (args, deps) => {
    const requester = str(args, 'requester_user_id');
    const audit = await auditOpen({ tool: 'start_code_check', args, access: deps.access, kind: 'code_checks', requester, dry_run: false });
    if (deps.agent || !cc.RECORDERS.has(requester)) {
      await auditClose(audit, { outcome: 'refused', detail: 'not_permitted' });
      return { ok: false, reason: 'not_permitted', message: 'Destiny or Jason, on the connector. Nothing was changed.', audit_id: audit };
    }
    const id = str(args, 'codex_entry_id');
    const auto = typeof args.auto === 'boolean' ? await draft.setAuto(args.auto, requester) : undefined;
    const r = id ? await draft.start(id) : { ok: true, message: auto ? `Automatic starts are on from ${auto}.` : 'Automatic starts are off.' };
    await auditClose(audit, { outcome: r.ok ? 'updated' : 'refused', detail: r.message, natural_id: id || null });
    return { ...r, auto_from: await draft.autoFrom(), audit_id: audit };
  },
};

export const CODE_CHECK_READ_TOOLS: ToolDefinition[] = [readCodeChecks];
export const CODE_CHECK_WRITE_TOOLS: ToolDefinition[] = [submitCodeCheckDraft, startCodeCheck, recordCodeCheck, prepareCodeCheck, writeAuditOutput, codeCheckAlertTrial, syncCodeCheckToBharag];
