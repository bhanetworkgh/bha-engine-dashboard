/**
 * test_logstream_e2e (10 Nov 2026, Destiny). Jason's LogStream checks proved end to end on real Bays — Submit
 * Actions runs, with no one submitting by hand (logstreamE2e.ts). A person's tool: write connection only, in no
 * agent's scope, refused on any agent token, Destiny or Jason, confirm "TEST LOGSTREAM". Audited on engine_mcp_writes
 * (kind codex_test), refused and dry-run ones included.
 */
import * as e2e from '../logstreamE2e';
import { ADMIN_IDS } from '../writeGuards';
import { currentAgent } from './caller';
import { auditClose, auditOpen } from './writeTools';
import type { ToolDefinition } from './tools';

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

export const testLogstreamE2eTool: ToolDefinition = {
  name: 'test_logstream_e2e',
  description:
    'Prove Jason\'s LogStream pay checks end to end on real Bays — Submit Actions runs, without anyone submitting a log. One step per call, for one run label: submit (case relog_undeclared, local_only or silent_failure: a typed TEST log goes through Submit Actions exactly as the Front Door hands it over, as you, ephemeral notes in channel_id; Layer 0, the earlier-work check and Layer 1 run for real and take a few minutes), answer (relog_undeclared only: presses Complete & Send on its parked row with the earlier-work answer, as the builder would), judge (reads the Codex row, the parked row and the run back and passes or fails each check, including the suggestion the Approve pop-up opens on), status (what each case has so far) and cleanup (deletes this run\'s TEST Codex and parked rows, Jason\'s review cards in #bha-log-reviews and parked notices; only rows whose Session URL starts with the run\'s TEST prefix). Jason sees the TEST cards until cleanup. Nothing is approved and no pay note is written. The Approve click itself is not tested. requester_user_id: Destiny or Jason. confirm exactly "TEST LOGSTREAM" (not needed for judge or status).',
  inputSchema: {
    type: 'object',
    properties: {
      step: { type: 'string', enum: [...e2e.STEPS] },
      case: { type: 'string', enum: [...e2e.CASES], description: 'For submit and judge.' },
      run: { type: 'string', description: 'The run label, letters and digits, the same on every step of one run.' },
      channel_id: { type: 'string', description: 'For submit and answer: the log channel the ephemeral notes go to (only you see them), e.g. #workflow-logs-destiny C0AFPJ5S1C1.' },
      confirm: { type: 'string', description: 'Exactly "TEST LOGSTREAM" for submit, answer and cleanup.' },
      requester_user_id: { type: 'string', description: 'Destiny or Jason.' },
      dry_run: { type: 'boolean', description: 'For submit: return the TEST log that would be sent, and send nothing.' },
    },
    required: ['step', 'run', 'requester_user_id'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true, title: 'Test the LogStream checks end to end' },
  handler: async (args, deps) => {
    const requester = str(args.requester_user_id) || null;
    const step = str(args.step) as e2e.E2eStep;
    const kase = str(args.case) as e2e.E2eCase;
    const run = e2e.cleanRun(args.run);
    const channel = str(args.channel_id);
    const dry = args.dry_run === true;
    const audit = await auditOpen({ tool: 'test_logstream_e2e', args, access: deps.access, kind: 'codex_test', requester, dry_run: dry });
    const refuse = async (why: string, message: string) => {
      await auditClose(audit, { outcome: 'refused', detail: `${why}: ${message}`, guard_result: { reason: why } });
      return { ok: false, reason: why, message: `${message} Nothing was sent.`, audit_id: audit };
    };
    if (currentAgent()) return refuse('agent_token', 'This is a person\'s tool and is refused on an agent token.');
    if (!requester || !ADMIN_IDS.includes(requester)) return refuse('not_permitted', 'Only Destiny or Jason can run the LogStream test.');
    if (!e2e.STEPS.includes(step)) return refuse('bad_step', `step must be one of ${e2e.STEPS.join(', ')}.`);
    if (!run) return refuse('run_required', 'run must be a label of letters and digits, the same on every step.');
    if ((step === 'submit' || step === 'judge') && !e2e.CASES.includes(kase)) return refuse('bad_case', `case must be one of ${e2e.CASES.join(', ')}.`);
    if ((step === 'submit' || step === 'answer') && !/^[CG][A-Z0-9]{6,}$/.test(channel)) return refuse('bad_channel', 'channel_id must be a Slack channel id (C… or G…).');
    if (['submit', 'answer', 'cleanup'].includes(step) && str(args.confirm) !== 'TEST LOGSTREAM') return refuse('confirm_required', 'confirm must be exactly "TEST LOGSTREAM".');
    try {
      let out: Record<string, unknown>;
      if (step === 'submit' && dry) {
        out = { ok: true, dry_run: true, session_url: e2e.sessionUrl(run, kase), would_send: e2e.caseLog(kase, run), message: 'Nothing was sent.' };
        await auditClose(audit, { outcome: 'dry_run', detail: `would submit ${kase} for run ${run}` });
        return { ...out, audit_id: audit };
      }
      if (step === 'submit') out = { ok: true, ...(await e2e.submit({ requester, channel_id: channel, run, case: kase })) };
      else if (step === 'answer') out = { ok: true, ...(await e2e.answer({ requester, channel_id: channel, run })) };
      else if (step === 'status') out = { ok: true, run, cases: await e2e.status(run) };
      else if (step === 'judge') {
        const v = await e2e.judgeCase(run, kase);
        out = { ok: v.pass, ...v, raise: !v.pass };
      } else out = { ...(await e2e.cleanup(run, `test_logstream_e2e by ${requester}`)) };
      await auditClose(audit, { outcome: out.ok === false ? 'failed' : 'applied', detail: `${step}${kase ? ` ${kase}` : ''} run ${run}: ${out.ok === false ? 'failed' : 'ok'}`, after: out });
      return { ...out, audit_id: audit };
    } catch (e) {
      const reason = e instanceof e2e.E2eError ? e.reason : 'failed';
      const message = e instanceof Error ? e.message : String(e);
      await auditClose(audit, { outcome: e instanceof e2e.E2eError ? 'refused' : 'failed', detail: `${reason}: ${message}`, guard_result: { reason } });
      return { ok: false, reason, message, raise: !(e instanceof e2e.E2eError), audit_id: audit };
    }
  },
};

export const LOGSTREAM_E2E_WRITE_TOOLS: ToolDefinition[] = [testLogstreamE2eTool];
