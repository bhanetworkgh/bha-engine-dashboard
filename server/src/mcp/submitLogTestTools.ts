/**
 * test_submit_log (2026-10-21, Destiny — INC-BAYS.CODEX-036). Proves the log form's
 * field-mistake path end to end without anyone posting in Slack: one deliberately broken
 * submission through Bays — Submit Actions, then the run read back and judged node by node
 * (submitLogTest.ts). A person's tool: write connection only, in no agent's scope, Destiny or
 * Jason, confirm "TEST SUBMIT LOG". The note it causes is a real post in the channel given.
 * Audited on engine_mcp_writes (kind codex_test), refused and dry-run ones included.
 */
import * as fieldCheck from '../submitLogTest';
import { ADMIN_IDS } from '../writeGuards';
import { auditClose, auditOpen } from './writeTools';
import type { ToolDefinition } from './tools';

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

export const testSubmitLogTool: ToolDefinition = {
  name: 'test_submit_log',
  description:
    'Prove the Codex log form tells a builder what to fix when a field is wrong, without anyone posting in Slack. Sends ONE deliberately broken submission through Bays — Submit Actions exactly as Bays — Front Door does (case: swapped = a title in Session URL and the Otter link in Description, the 20 Oct mistake; not_a_link; missing_description), as you, in channel_id, then reads the run back from n8n and judges it: the form check refused it, the note posted in the channel and Slack said ok, the note says what to fix, the Slack answer was checked, and nothing past the check (the scraper, the submission row) ran. It can never save a log or reach the scraper: the runner refuses anything that would pass. The note is a real message in channel_id. requester_user_id: Destiny or Jason. confirm exactly "TEST SUBMIT LOG". dry_run checks the request and sends nothing. Returns {pass, checks, execution_id, execution_url, note}.',
  inputSchema: {
    type: 'object',
    properties: {
      case: { type: 'string', enum: [...fieldCheck.CASES], description: 'Which mistake to send. Default swapped.' },
      channel_id: { type: 'string', description: 'The log channel the note goes to, e.g. #workflow-logs-destiny C0AFPJ5S1C1.' },
      run: { type: 'string', description: 'A label for this run, letters, digits or hyphens. Shown in the test submission.' },
      confirm: { type: 'string', description: 'Exactly "TEST SUBMIT LOG".' },
      requester_user_id: { type: 'string', description: 'Slack id of the person running it: Destiny or Jason.' },
      dry_run: { type: 'boolean' },
    },
    required: ['channel_id', 'requester_user_id'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true, title: 'Test the log form field-mistake path' },
  handler: async (args, deps) => {
    const requester = str(args.requester_user_id) || null;
    const channel = str(args.channel_id);
    const kase = (str(args.case) || 'swapped') as fieldCheck.FieldCase;
    const run = str(args.run).replace(/[^A-Za-z0-9-]/g, '').slice(0, 40) || new Date().toISOString().slice(0, 16).replace(/[^0-9]/g, '');
    const dry = args.dry_run === true;
    const audit = await auditOpen({ tool: 'test_submit_log', args, access: deps.access, kind: 'codex_test', requester, dry_run: dry });
    const refuse = async (why: string, message: string) => {
      await auditClose(audit, { outcome: 'refused', detail: `${why}: ${message}`, guard_result: { reason: why } });
      return { ok: false, reason: why, message: `${message} Nothing was sent.`, audit_id: audit };
    };
    if (!requester || !ADMIN_IDS.includes(requester)) return refuse('not_permitted', 'Only Destiny or Jason can run the field check.');
    if (!fieldCheck.CASES.includes(kase)) return refuse('bad_case', `case must be one of ${fieldCheck.CASES.join(', ')}.`);
    if (!/^[CG][A-Z0-9]{6,}$/.test(channel)) return refuse('bad_channel', 'channel_id must be a Slack channel id (C… or G…).');
    if (str(args.confirm) !== 'TEST SUBMIT LOG') return refuse('confirm_required', 'confirm must be exactly "TEST SUBMIT LOG".');
    if (dry) {
      await auditClose(audit, { outcome: 'dry_run', detail: `would send case ${kase} to ${channel}` });
      return { ok: true, dry_run: true, would_send: { case: kase, channel_id: channel, run }, message: 'Nothing was sent.', audit_id: audit };
    }
    try {
      const username = requester === 'U0AEW3TBYH1' ? 'destiny' : 'jason';
      const result = await fieldCheck.run({ requester, username, channel_id: channel, case: kase, run });
      await auditClose(audit, {
        outcome: result.pass ? 'applied' : 'failed',
        detail: `field check ${kase} ${result.pass ? 'passed' : 'failed'}; execution ${result.execution_id ?? 'not found'}`,
        natural_id: result.execution_id,
        after: result,
      });
      return { ok: result.pass, ...result, raise: !result.pass, audit_id: audit };
    } catch (e) {
      const reason = e instanceof fieldCheck.FieldCheckError ? e.reason : 'failed';
      const message = e instanceof Error ? e.message : String(e);
      await auditClose(audit, { outcome: e instanceof fieldCheck.FieldCheckError ? 'refused' : 'failed', detail: `${reason}: ${message}`, guard_result: { reason } });
      return { ok: false, reason, message, raise: true, audit_id: audit };
    }
  },
};

export const SUBMIT_LOG_TEST_WRITE_TOOLS: ToolDefinition[] = [testSubmitLogTool];
