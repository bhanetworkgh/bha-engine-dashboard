/**
 * `ask_genie` (19 Nov 2026, Destiny — Genie rebuild step 10.1). Write connection, in Bays' scope: Bays hands
 * Genie a question it was asked in a Slack thread that is Genie's to answer (GitHub, Render, building or fixing
 * an n8n workflow, a long or deep piece of reasoning, a log or code review). Genie answers in that same thread,
 * as Genie, exactly as if it had been tagged there, and never hands it back. The call goes to Genie's
 * POST /api/genie/engine-ask with the inbound key Genie already holds (the same key its post-card route reads),
 * so no new secret. Accepted means handed over, never answered: the answer is Genie's to post. A refusal or an
 * unreachable Genie is ok:false with the reason, and Bays tells the person to ask @Genie directly.
 * Audited on engine_mcp_writes (kind genie); each hand-off is one genie_handoff_requested event (lane GENIE).
 */
import * as engineEvents from '../engineEvents';
import { unknownRecipients, destinationVerdict } from './slackTools';
import { auditClose, auditOpen } from './writeTools';
import type { ToolDefinition } from './tools';

export function genieUrl(): string {
  return (process.env.GENIE_URL || 'https://genie-v3-migration-u82u.onrender.com').replace(/\/+$/, '');
}

/** The checks on the arguments, pure. Null when they pass. */
export function argProblem(a: { channel_id: string; thread_ts: string; asked_by: string; question: string }): string | null {
  if (!/^[CG][A-Z0-9]{6,}$/.test(a.channel_id)) return 'channel_id must be the Slack channel the ask came from (C… or G…). Genie answers in a channel thread only.';
  if (!/^\d+\.\d+$/.test(a.thread_ts)) return 'thread_ts must be the ts of the thread the ask is in (from your context block).';
  if (!/^[UW][A-Z0-9]{6,}$/.test(a.asked_by)) return 'asked_by must be the Slack id of the person who asked.';
  if (a.question.length < 3 || a.question.length > 8000) return 'question must be 3 to 8,000 characters: the person\'s question in their own words, with anything Genie needs from the thread.';
  return null;
}

export const askGenie: ToolDefinition = {
  name: 'ask_genie',
  description:
    "Hand a question to Genie, which answers in the same Slack thread as Genie. Use it when someone asks you about GitHub (a repo, a PR, a commit), Render (a deploy, a service, its logs), building or fixing an n8n workflow, or anything that needs long, deep reasoning or a log or code review: those are Genie's. Set deep: true for a second opinion, a high-stakes or architectural question, or a log or code review (this replaces Deep_Think: Genie answers it on Opus 5.5). Pass the person's question in their own words, with anything Genie needs from the thread, the channel_id and thread_ts from your context block, and asked_by, the Slack id of the person who asked. Then tell the person in one line that you have handed it to Genie and it will answer here. Do not answer the question yourself as well. ok:false means it was not handed over: say why and tell the person to ask @Genie directly in the thread.",
  inputSchema: {
    type: 'object',
    properties: {
      question: { type: 'string', description: "The person's question in their own words, with any context Genie needs." },
      channel_id: { type: 'string', description: 'The Slack channel the ask came from (C… or G…).' },
      thread_ts: { type: 'string', description: 'The ts of the thread to answer in.' },
      asked_by: { type: 'string', description: 'The Slack id of the person who asked.' },
      deep: { type: 'boolean', description: 'true for a second opinion, a high-stakes or architectural question, or a log or code review: Genie answers it on Opus 5.5. Leave it out for everything else.' },
      dry_run: { type: 'boolean', description: 'Check everything and hand nothing over.' },
    },
    required: ['question', 'channel_id', 'thread_ts', 'asked_by'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true, title: 'Hand a question to Genie' },
  handler: async (args, deps) => {
    const a = {
      question: String(args.question ?? '').trim(),
      channel_id: String(args.channel_id ?? '').trim(),
      thread_ts: String(args.thread_ts ?? '').trim(),
      asked_by: String(args.asked_by ?? '').trim(),
    };
    const dry = args.dry_run === true;
    const deep = args.deep === true;
    const audit = await auditOpen({ tool: 'ask_genie', args, access: deps.access, kind: 'genie', requester: a.asked_by || null, dry_run: dry });
    const refuse = async (reason: string, message: string) => {
      await auditClose(audit, { outcome: 'refused', detail: `${reason}: ${message}` });
      return { ok: false, reason, handed_over: false, message, audit_id: audit };
    };
    const bad = argProblem(a);
    if (bad) return refuse('bad_arguments', bad);
    if ((await unknownRecipients([a.asked_by])).length) return refuse('unknown_person', `${a.asked_by} has no Builder Profile and is not Destiny or Jason, so the ask is not handed over.`);
    const dest = await destinationVerdict(a.channel_id);
    if (!dest.known) return refuse('unknown_channel', `Genie is not asked to post in ${a.channel_id}: ${dest.why}.`);
    if (dry) {
      await auditClose(audit, { outcome: 'dry_run', detail: `would hand to Genie in ${a.channel_id}/${a.thread_ts}` });
      return { ok: true, dry_run: true, handed_over: false, would_post_in: { channel_id: a.channel_id, thread_ts: a.thread_ts }, audit_id: audit };
    }
    const key = process.env.DASHBOARD_INBOUND_KEY?.trim();
    if (!key) return refuse('not_configured', 'DASHBOARD_INBOUND_KEY is not set on the dashboard, so Genie cannot be asked.');
    let status = 0;
    let body: { ok?: boolean; error?: string } = {};
    try {
      const res = await fetch(`${genieUrl()}/api/genie/engine-ask`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-dashboard-key': key },
        // 24 Nov 2026 (INC-BAYS.AGENT-130): base64, because Render's firewall refuses a question that quotes curl or SQL.
        body: JSON.stringify({ body_b64: Buffer.from(JSON.stringify({ channel: a.channel_id, thread_ts: a.thread_ts, asked_by: a.asked_by, question: a.question, from: 'bays', deep }), 'utf8').toString('base64') }),
        signal: AbortSignal.timeout(20_000),
      });
      status = res.status;
      body = (await res.json().catch(() => ({}))) as typeof body;
    } catch (e) {
      const why = `Genie could not be reached: ${e instanceof Error ? e.message : String(e)}`;
      await auditClose(audit, { outcome: 'failed', detail: why });
      return { ok: false, reason: 'genie_unreachable', handed_over: false, raise: true, message: why, audit_id: audit };
    }
    if (status !== 202 || body.ok !== true) {
      const why = `Genie refused the hand-off (HTTP ${status}): ${body.error ?? (status === 403 ? 'no JSON answer, most likely Render\'s firewall before Genie' : 'no reason given')}`;
      await auditClose(audit, { outcome: 'failed', detail: why });
      return { ok: false, reason: 'genie_refused', handed_over: false, raise: true, message: why, audit_id: audit };
    }
    await engineEvents.record({
      event_type: 'genie_handoff_requested', subject_id: `${a.channel_id}/${a.thread_ts}`, lane: 'GENIE', actor: 'bays',
      detail: { from: 'bays', asked_by: a.asked_by, channel_id: a.channel_id, thread_ts: a.thread_ts, question: a.question.slice(0, 600), deep, audit_id: audit },
    }).catch(() => undefined);
    await auditClose(audit, { outcome: 'applied', detail: `handed to Genie${deep ? ' (deep, Opus 5.5)' : ''} in ${a.channel_id}/${a.thread_ts}` });
    return { ok: true, handed_over: true, message: 'Handed to Genie. Genie answers in this thread; tell the person so in one line and do not answer it yourself.', audit_id: audit };
  },
};

export const GENIE_ASK_WRITE_TOOLS: ToolDefinition[] = [askGenie];
